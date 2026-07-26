import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase, transcribeFunctionUrl } from '../lib/supabase'
import { formatDate } from '../lib/util'
import { ChatIcon, MicIcon, SaveIcon, SparkleIcon, StopIcon, TrashIcon } from '../components/icons'
import { MeetingChatPanel } from '../components/MeetingChatPanel'
import { streamChat } from '../lib/chat'

interface TranscriptSegment {
  text: string
  timestamp: number
  start?: number
  end?: number
}

// Where an in-progress meeting is stashed so a reload doesn't lose the
// transcript captured so far (client-side; the chat thread is already durable).
const STORAGE_KEY = 'meetingNotes:active'
// How often the ambient monitor checks the latest transcript for ideas.
const MONITOR_MS = 60000

export default function MeetingNotesPage() {
  const { user, session } = useAuth()
  const [isRecording, setIsRecording] = useState(false)
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([])
  const [status, setStatus] = useState<string>('Ready to record')
  const [saving, setSaving] = useState(false)
  const [meetingTitle, setMeetingTitle] = useState('')
  // null = not checked yet; true/false = whether the OPENAI_KEY secret is set.
  const [transcribeConfigured, setTranscribeConfigured] = useState<boolean | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  // Stable id for THIS meeting session — correlates the live chat thread
  // (conversations.meeting_id) with the artifact saved at the end. A fresh id
  // starts a fresh meeting (regenerated after save / clear).
  const [meetingId, setMeetingId] = useState<string>(() => crypto.randomUUID())
  // The meeting's context prompt: what to do with the transcript when it ends
  // (free text, optionally prefilled from a saved skill). Auto-runs on stop.
  const [meetingPrompt, setMeetingPrompt] = useState('')
  const meetingPromptRef = useRef('')
  const [skills, setSkills] = useState<Array<{ id: string; name: string; instructions: string }>>([])
  const [autoRun, setAutoRun] = useState<{ id: string; instruction: string } | undefined>(undefined)
  const autoRunAfterFinal = useRef(false)
  const transcribedRef = useRef(false)
  // Called by the recorder's onstop (defined below triggerAutoRun) via a ref to
  // sidestep declaration ordering.
  const triggerAutoRunRef = useRef<() => void>(() => {})
  // Ambient idea monitor (opt-in): periodically surface unprompted ideas from
  // the latest transcript while recording.
  const [monitorOn, setMonitorOn] = useState(false)
  const [ideas, setIdeas] = useState<string[]>([])
  const monitorBusyRef = useRef(false)
  const monitorLenRef = useRef(0)
  // Latest transcript length + text, read by the monitor's interval without
  // recreating it each render (avoids stale-closure over `transcript`).
  const transcriptLenRef = useRef(0)
  const transcriptTextRef = useRef<() => string>(() => '')

  // How long each transcription segment runs. Each segment is recorded by its
  // OWN MediaRecorder so the resulting blob is a complete, self-contained webm
  // file (header + data). A single long recorder sliced into pieces only puts
  // the container header on the FIRST slice, so every later slice fails to
  // decode — that was the original bug.
  const SEGMENT_MS = 15000

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null) // the (possibly mixed) stream fed to MediaRecorder
  const micStreamRef = useRef<MediaStream | null>(null)
  const displayStreamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const startTimeRef = useRef<number>(0)
  const recordingRef = useRef(false)
  const mimeTypeRef = useRef<string>('audio/webm')
  const rotateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transcriptScrollRef = useRef<HTMLDivElement>(null)
  // Also capture tab/app audio (Zoom, Meet, Slack huddle) alongside the mic.
  const [captureSystem, setCaptureSystem] = useState(false)

  const transcribeBlob = useCallback(async (audioBlob: Blob) => {
    if (audioBlob.size === 0) return

    const formData = new FormData()
    formData.append('audio', audioBlob, 'segment.webm')

    setStatus('Transcribing...')

    try {
      const response = await fetch(transcribeFunctionUrl(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session?.access_token}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: formData,
      })

      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error || `Transcription failed (${response.status})`)
      }

      const result = await response.json()

      if (result.text && result.text.trim()) {
        transcribedRef.current = true
        const now = Date.now()
        const elapsed = (now - startTimeRef.current) / 1000

        setTranscript((prev) => [
          ...prev,
          {
            text: result.text.trim(),
            timestamp: now,
            start: Math.max(0, elapsed - (result.duration || SEGMENT_MS / 1000)),
            end: elapsed,
          },
        ])
      }

      setStatus(recordingRef.current ? 'Recording...' : 'Ready to record')
    } catch (error) {
      console.error('Transcription error:', error)
      setStatus(`Transcription error: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }, [session])

  // Record one segment. On stop it ships a complete webm file for transcription
  // and — if we're still recording — immediately starts the next segment.
  const startSegment = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return

    const mediaRecorder = new MediaRecorder(stream, { mimeType: mimeTypeRef.current })
    const chunks: Blob[] = []
    mediaRecorderRef.current = mediaRecorder

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeTypeRef.current })
      const done = transcribeBlob(blob)
      if (recordingRef.current) {
        startSegment()
      } else if (autoRunAfterFinal.current) {
        // Final segment: run the meeting's context prompt once it has transcribed.
        autoRunAfterFinal.current = false
        void done.finally(() => triggerAutoRunRef.current())
      }
    }

    mediaRecorder.start()
    // Each segment schedules its own stop; onstop rolls into the next segment.
    rotateTimerRef.current = setTimeout(() => {
      if (mediaRecorder.state === 'recording') mediaRecorder.stop()
    }, SEGMENT_MS)
  }, [transcribeBlob])

  // Stop every capture source (mixed output, mic, shared tab/app) and close the
  // mixing graph. Safe to call more than once.
  const teardownStreams = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    displayStreamRef.current?.getTracks().forEach((t) => t.stop())
    audioCtxRef.current?.close().catch(() => {})
    streamRef.current = null
    micStreamRef.current = null
    displayStreamRef.current = null
    audioCtxRef.current = null
  }, [])

  // Build the stream MediaRecorder captures. Mic only, or — when `withSystem` —
  // the mic mixed with shared tab/app audio (Zoom/Meet/Slack) via Web Audio, so
  // Whisper hears both sides. getDisplayMedia is requested FIRST to stay inside
  // the click's user-gesture; if the user cancels or shares no audio, we fall
  // back to mic-only rather than failing.
  const buildRecordingStream = useCallback(async (withSystem: boolean): Promise<MediaStream> => {
    let display: MediaStream | null = null
    if (withSystem) {
      try {
        display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      } catch {
        display = null // user dismissed the picker
      }
    }

    // When we're mixing in tab/app audio, DISABLE the mic's echo cancellation /
    // noise suppression / auto-gain. Otherwise the browser treats the loud tab
    // audio (played on the speakers) as far-end "echo" and ducks the mic — so
    // your voice vanishes while a video plays and returns when it's paused.
    const mixing = !!display
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: mixing
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : true,
    })
    micStreamRef.current = mic

    if (!display) return mic

    const sysTracks = display.getAudioTracks()
    if (sysTracks.length === 0) {
      display.getTracks().forEach((t) => t.stop())
      setStatus('No tab/app audio was shared — recording your mic only. Re-share and tick “Share tab audio”.')
      return mic
    }

    displayStreamRef.current = display // keep alive; sharing indicator stays up
    const ctx = new AudioContext()
    audioCtxRef.current = ctx
    await ctx.resume().catch(() => {})
    const dest = ctx.createMediaStreamDestination()
    // Slightly boost the mic relative to tab audio so your voice stays present
    // when the tab audio is loud.
    const micGain = ctx.createGain()
    micGain.gain.value = 1.4
    ctx.createMediaStreamSource(mic).connect(micGain).connect(dest)
    ctx.createMediaStreamSource(new MediaStream(sysTracks)).connect(dest)
    return dest.stream
  }, [])

  const startRecording = useCallback(async () => {
    try {
      const stream = await buildRecordingStream(captureSystem)
      streamRef.current = stream

      // Use webm/opus for better browser compatibility
      mimeTypeRef.current = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      startTimeRef.current = Date.now()
      recordingRef.current = true
      setIsRecording(true)
      setStatus(captureSystem && displayStreamRef.current ? 'Recording (mic + shared audio)…' : 'Recording...')
      startSegment()
    } catch (error) {
      console.error('Error starting recording:', error)
      teardownStreams()
      setStatus(`Error: ${error instanceof Error ? error.message : 'Could not access microphone'}`)
    }
  }, [startSegment, buildRecordingStream, captureSystem, teardownStreams])

  const stopRecording = useCallback(() => {
    recordingRef.current = false
    autoRunAfterFinal.current = true // run the context prompt after the last segment
    if (rotateTimerRef.current) {
      clearTimeout(rotateTimerRef.current)
      rotateTimerRef.current = null
    }
    // Stopping flushes the final segment (onstop transcribes it, no re-start).
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    teardownStreams()
    setIsRecording(false)
    setStatus('Recording stopped. Review and save.')
  }, [teardownStreams])

  // Formatted transcript text (with [m:ss] stamps), reused by the chat panel and
  // the ambient monitor.
  const buildTranscriptText = useCallback(
    () =>
      transcript
        .map((seg) => {
          const t =
            seg.start !== undefined
              ? `[${Math.floor(seg.start / 60)}:${String(Math.floor(seg.start % 60)).padStart(2, '0')}] `
              : ''
          return `${t}${seg.text}`.trim()
        })
        .join('\n\n'),
    [transcript],
  )

  const clearTranscript = useCallback(() => {
    if (confirm('Clear the current transcript? This cannot be undone.')) {
      setTranscript([])
      setMeetingTitle('')
      setMeetingPrompt('')
      setStatus('Ready to record')
      setMeetingId(crypto.randomUUID()) // fresh meeting → fresh chat thread
      setChatOpen(false)
      setAutoRun(undefined)
      setIdeas([])
      transcribedRef.current = false
      monitorLenRef.current = 0
      try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
    }
  }, [])

  const saveAsArtifact = useCallback(async () => {
    if (transcript.length === 0) {
      alert('No transcript to save')
      return
    }

    if (!meetingTitle.trim()) {
      alert('Please enter a meeting title')
      return
    }

    setSaving(true)
    setStatus('Saving...')

    try {
      // Format transcript as markdown
      const content = transcript
        .map((seg) => {
          const timeStr = seg.start !== undefined
            ? `[${Math.floor(seg.start / 60)}:${String(Math.floor(seg.start % 60)).padStart(2, '0')}]`
            : ''
          return `${timeStr} ${seg.text}`.trim()
        })
        .join('\n\n')

      const fullContent = `# ${meetingTitle}\n\n**Date:** ${formatDate(new Date().toISOString())}\n\n## Transcript\n\n${content}`

      const { data: artifact, error } = await supabase
        .from('artifacts')
        .insert({
          owner_id: user!.id,
          title: meetingTitle,
          type: 'markdown',
          content: fullContent,
          visibility: 'private',
          data: {
            meeting_notes: true,
            meeting_id: meetingId,
            recorded_at: new Date().toISOString(),
            duration: transcript.length > 0 && transcript[transcript.length - 1].end
              ? Math.round(transcript[transcript.length - 1].end!)
              : 0,
          },
        })
        .select()
        .single()

      if (error) throw error

      setStatus('Saved successfully!')
      try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }

      // Clear the transcript after successful save
      setTimeout(() => {
        setTranscript([])
        setMeetingTitle('')
        setStatus('Ready to record')
      }, 2000)

      // Navigate to the artifact
      window.location.href = `/artifacts/${artifact.id}`
    } catch (error) {
      console.error('Error saving artifact:', error)
      setStatus(`Error saving: ${error instanceof Error ? error.message : 'Unknown error'}`)
      setSaving(false)
    }
  }, [transcript, meetingTitle, user, meetingId])

  // Keep the prompt ref in sync so the recorder callbacks read the latest value.
  useEffect(() => { meetingPromptRef.current = meetingPrompt }, [meetingPrompt])

  // Load the user's on-demand skills as pickable meeting context prompts.
  useEffect(() => {
    if (!user) return
    let active = true
    supabase
      .from('skills')
      .select('id, name, instructions')
      .eq('auto_apply', false)
      .order('name', { ascending: true })
      .then(({ data }) => {
        if (active && data) setSkills(data)
      })
    return () => { active = false }
  }, [user])

  // Run the meeting's context prompt over the transcript (fired once the final
  // segment has transcribed). No-ops if there's no prompt or nothing was said.
  const triggerAutoRun = useCallback(() => {
    const instruction = meetingPromptRef.current.trim()
    if (!instruction || !transcribedRef.current) return
    setChatOpen(true)
    setAutoRun({ id: crypto.randomUUID(), instruction })
  }, [])
  useEffect(() => { triggerAutoRunRef.current = triggerAutoRun }, [triggerAutoRun])

  // Keep the monitor's refs current each render.
  useEffect(() => {
    transcriptLenRef.current = transcript.length
    transcriptTextRef.current = buildTranscriptText
  }, [transcript, buildTranscriptText])

  // Restore an in-progress meeting after a reload (client-side; the chat thread
  // is already durable via meeting_id). Runs once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw)
      if (saved?.meetingId && Array.isArray(saved.transcript) && saved.transcript.length) {
        setMeetingId(saved.meetingId)
        setMeetingTitle(saved.title || '')
        setMeetingPrompt(saved.prompt || '')
        setTranscript(saved.transcript)
        transcribedRef.current = true
        setStatus('Restored an in-progress meeting — resume recording or save.')
      }
    } catch { /* ignore */ }
  }, [])

  // Keep the transcript scrolled to the newest segment — but only when the user
  // is already near the bottom, so scrolling up to re-read isn't yanked away.
  useEffect(() => {
    const el = transcriptScrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140
    if (nearBottom) el.scrollTo({ top: el.scrollHeight })
  }, [transcript])

  // Persist the in-progress meeting whenever it changes.
  useEffect(() => {
    if (transcript.length === 0) return
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ meetingId, title: meetingTitle, prompt: meetingPrompt, transcript }),
      )
    } catch { /* ignore quota */ }
  }, [transcript, meetingId, meetingTitle, meetingPrompt])

  // Ambient idea monitor (opt-in): every MONITOR_MS while recording, if new
  // transcript has landed, ask the model for one idea/question/action worth
  // flagging. Runs tool-free (toolIds:[]) so it never acts, only observes.
  useEffect(() => {
    if (!isRecording || !monitorOn) return
    const controller = new AbortController()
    const id = setInterval(() => {
      if (monitorBusyRef.current) return
      const len = transcriptLenRef.current
      if (len <= monitorLenRef.current) return // nothing new since last check
      monitorBusyRef.current = true
      monitorLenRef.current = len
      const title = meetingTitle.trim() || 'Untitled meeting'
      void streamChat(
        [{
          role: 'user',
          content:
            'From the latest part of this meeting, surface ONE brief, useful idea, open question, or action item a participant might miss. Reply with a single short sentence. If nothing stands out, reply with exactly "NONE".',
        }],
        () => {},
        {
          system: `You are silently monitoring a live meeting titled "${title}". Transcript so far:\n\n${transcriptTextRef.current()}`,
          toolIds: [],
          signal: controller.signal,
        },
      )
        .then((full) => {
          const t = full.trim()
          if (t && !/^none\b/i.test(t)) setIdeas((prev) => [...prev, t])
        })
        .catch(() => { /* ignore monitor errors */ })
        .finally(() => { monitorBusyRef.current = false })
    }, MONITOR_MS)
    return () => {
      clearInterval(id)
      controller.abort()
    }
  }, [isRecording, monitorOn, meetingTitle])

  // Check up front whether transcription is configured (OPENAI_KEY secret set)
  // so we can warn before the user records rather than failing mid-session.
  useEffect(() => {
    if (!session?.access_token) return
    let cancelled = false
    ;(async () => {
      try {
        const response = await fetch(transcribeFunctionUrl(), {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
        })
        if (!response.ok) return // don't block on a probe failure
        const result = await response.json()
        if (!cancelled) setTranscribeConfigured(Boolean(result?.configured))
      } catch {
        // Ignore probe errors — recording will surface a real error if needed.
      }
    })()
    return () => { cancelled = true }
  }, [session])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recordingRef.current = false
      if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current)
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      teardownStreams()
    }
  }, [teardownStreams])

  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-6 p-6 lg:flex-row">
      <div className="min-w-0 flex-1">
      {transcribeConfigured === false && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900
                        dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="font-semibold">Transcription isn't set up yet</p>
          <p className="mt-1 text-sm">
            Meeting notes transcribe audio with OpenAI Whisper (the app's usual OpenRouter
            provider has no audio/transcription endpoint). An admin needs to add a workspace
            secret named{' '}
            <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs dark:bg-amber-500/20">
              OPENAI_KEY
            </code>{' '}
            in Settings → Secrets. Until then, recording will capture audio but produce no
            transcript.
          </p>
        </div>
      )}

      <div className="mb-6">
        <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
          Meeting Notes
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Record audio and get a live transcript. Saved as an artifact.
        </p>
      </div>

      {/* Recording Controls */}
      <div className="bg-white dark:bg-zinc-800 rounded-lg p-6 mb-6 shadow-sm border border-zinc-200 dark:border-zinc-700">
        <div className="mb-4">
          <label htmlFor="meeting-title" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
            Meeting Title
          </label>
          <input
            id="meeting-title"
            type="text"
            value={meetingTitle}
            onChange={(e) => setMeetingTitle(e.target.value)}
            placeholder="e.g., Weekly Team Sync"
            disabled={isRecording}
            className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-600 rounded-lg
                     bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100
                     focus:outline-none focus:ring-2 focus:ring-purple-500 dark:focus:ring-purple-600
                     disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>

        {/* Context prompt: what to do with the transcript. Runs on stop. */}
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <label htmlFor="meeting-prompt" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              What should I do with this meeting? <span className="text-zinc-400">(optional)</span>
            </label>
            {skills.length > 0 && (
              <select
                aria-label="Prefill from a saved skill"
                value=""
                onChange={(e) => {
                  const s = skills.find((x) => x.id === e.target.value)
                  if (s) setMeetingPrompt(s.instructions)
                }}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700
                         dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
              >
                <option value="">Use a skill…</option>
                {skills.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
          </div>
          <textarea
            id="meeting-prompt"
            value={meetingPrompt}
            onChange={(e) => setMeetingPrompt(e.target.value)}
            placeholder="e.g. Summarise the decisions and create a to-do for each action item. Runs automatically when you stop recording."
            rows={2}
            className="w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm
                     text-zinc-900 focus:outline-none focus:ring-2 focus:ring-purple-500
                     dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:ring-purple-600"
          />
        </div>

        {/* Also capture the audio of a call/video (Zoom, Meet, Slack huddle). */}
        <div className="mb-4">
          <label className="flex cursor-pointer items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={captureSystem}
              onChange={(e) => setCaptureSystem(e.target.checked)}
              disabled={isRecording}
              className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-purple-600 focus:ring-purple-500
                       disabled:opacity-50 dark:border-zinc-600"
            />
            <span>
              Also capture tab/app audio (Zoom, Meet, Slack huddle)
              <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
                On start you'll pick the tab/window to listen to — tick “Share tab audio”. Your mic is
                always captured too. Best in Chrome; Safari support is limited.
              </span>
            </span>
          </label>
        </div>

        <div className="flex items-center gap-3 mb-4">
          {!isRecording ? (
            <button
              onClick={startRecording}
              disabled={!meetingTitle.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-red-500 hover:bg-red-600
                       text-white rounded-lg font-medium transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <MicIcon className="h-5 w-5" />
              Start Recording
            </button>
          ) : (
            <button
              onClick={stopRecording}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-500 hover:bg-zinc-600
                       text-white rounded-lg font-medium transition-colors"
            >
              <StopIcon className="h-5 w-5" />
              Stop Recording
            </button>
          )}

          {transcript.length > 0 && !isRecording && (
            <>
              <button
                onClick={saveAsArtifact}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 bg-purple-500 hover:bg-purple-600
                         text-white rounded-lg font-medium transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <SaveIcon className="h-5 w-5" />
                {saving ? 'Saving...' : 'Save as Artifact'}
              </button>

              <button
                onClick={clearTranscript}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 bg-zinc-200 hover:bg-zinc-300
                         dark:bg-zinc-700 dark:hover:bg-zinc-600 text-zinc-900 dark:text-zinc-100
                         rounded-lg font-medium transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <TrashIcon className="h-5 w-5" />
                Clear
              </button>
            </>
          )}

          {/* Chat about the meeting — available during and after recording. */}
          <button
            onClick={() => setChatOpen((o) => !o)}
            className="ml-auto flex items-center gap-2 rounded-lg border border-zinc-300 px-4 py-2
                     font-medium text-zinc-700 transition-colors hover:bg-zinc-100
                     dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-700"
          >
            <ChatIcon className="h-5 w-5" />
            {chatOpen ? 'Hide chat' : 'Chat'}
          </button>
        </div>

        <div className="flex items-center gap-2 text-sm">
          {isRecording && (
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 bg-red-500 rounded-full animate-pulse" />
              <span className="text-red-500 font-medium">Recording</span>
            </span>
          )}
          <span className="text-zinc-600 dark:text-zinc-400">
            {status}
          </span>

          <label className="ml-auto flex cursor-pointer items-center gap-2 text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={monitorOn}
              onChange={(e) => setMonitorOn(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-300 text-purple-600 focus:ring-purple-500 dark:border-zinc-600"
            />
            Suggest ideas while recording
          </label>
        </div>
      </div>

      {/* Ambient ideas — unprompted thoughts surfaced by the monitor. */}
      {ideas.length > 0 && (
        <div className="mb-6 rounded-lg border border-purple-200 bg-purple-50 p-4
                        dark:border-purple-500/30 dark:bg-purple-500/10">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-purple-800 dark:text-purple-200">
            <SparkleIcon className="h-4 w-4" />
            Ideas &amp; prompts
          </div>
          <ul className="space-y-2">
            {ideas.map((idea, i) => (
              <li key={i} className="text-sm text-purple-900 dark:text-purple-100">• {idea}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Transcript Display */}
      {transcript.length > 0 && (
        <div className="bg-white dark:bg-zinc-800 rounded-lg p-6 shadow-sm border border-zinc-200 dark:border-zinc-700">
          <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mb-4">
            Transcript
          </h2>
          <div ref={transcriptScrollRef} className="space-y-4 max-h-96 overflow-y-auto scroll-smooth">
            {transcript.map((seg, i) => (
              <div key={i} className="border-l-2 border-purple-500 pl-4">
                {seg.start !== undefined && (
                  <div className="text-xs text-zinc-500 dark:text-zinc-500 mb-1">
                    {Math.floor(seg.start / 60)}:{String(Math.floor(seg.start % 60)).padStart(2, '0')}
                  </div>
                )}
                <p className="text-zinc-900 dark:text-zinc-100">{seg.text}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {transcript.length === 0 && !isRecording && (
        <div className="text-center py-12 text-zinc-500 dark:text-zinc-400">
          <MicIcon className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p>Start recording to see your transcript here</p>
        </div>
      )}
      </div>

      {chatOpen && (
        <div className="lg:w-[380px] lg:shrink-0">
          <div className="h-[70vh] overflow-hidden rounded-lg border border-border lg:sticky lg:top-6">
            <MeetingChatPanel
              meetingId={meetingId}
              meetingTitle={meetingTitle.trim() || 'Untitled meeting'}
              getTranscript={buildTranscriptText}
              autoRun={autoRun}
              onClose={() => setChatOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
