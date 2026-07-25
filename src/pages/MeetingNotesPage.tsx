import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase, transcribeFunctionUrl } from '../lib/supabase'
import { formatDate } from '../lib/util'
import { MicIcon, SaveIcon, StopIcon, TrashIcon } from '../components/icons'

interface TranscriptSegment {
  text: string
  timestamp: number
  start?: number
  end?: number
}

export default function MeetingNotesPage() {
  const { user, session } = useAuth()
  const [isRecording, setIsRecording] = useState(false)
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([])
  const [status, setStatus] = useState<string>('Ready to record')
  const [saving, setSaving] = useState(false)
  const [meetingTitle, setMeetingTitle] = useState('')

  // How long each transcription segment runs. Each segment is recorded by its
  // OWN MediaRecorder so the resulting blob is a complete, self-contained webm
  // file (header + data). A single long recorder sliced into pieces only puts
  // the container header on the FIRST slice, so every later slice fails to
  // decode — that was the original bug.
  const SEGMENT_MS = 15000

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const startTimeRef = useRef<number>(0)
  const recordingRef = useRef(false)
  const mimeTypeRef = useRef<string>('audio/webm')
  const rotateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
      void transcribeBlob(blob)
      if (recordingRef.current) startSegment()
    }

    mediaRecorder.start()
    // Each segment schedules its own stop; onstop rolls into the next segment.
    rotateTimerRef.current = setTimeout(() => {
      if (mediaRecorder.state === 'recording') mediaRecorder.stop()
    }, SEGMENT_MS)
  }, [transcribeBlob])

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Use webm/opus for better browser compatibility
      mimeTypeRef.current = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      startTimeRef.current = Date.now()
      recordingRef.current = true
      setIsRecording(true)
      setStatus('Recording...')
      startSegment()
    } catch (error) {
      console.error('Error starting recording:', error)
      setStatus(`Error: ${error instanceof Error ? error.message : 'Could not access microphone'}`)
    }
  }, [startSegment])

  const stopRecording = useCallback(() => {
    recordingRef.current = false
    if (rotateTimerRef.current) {
      clearTimeout(rotateTimerRef.current)
      rotateTimerRef.current = null
    }
    // Stopping flushes the final segment (onstop transcribes it, no re-start).
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    setIsRecording(false)
    setStatus('Recording stopped. Review and save.')
  }, [])

  const clearTranscript = useCallback(() => {
    if (confirm('Clear the current transcript? This cannot be undone.')) {
      setTranscript([])
      setMeetingTitle('')
      setStatus('Ready to record')
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
  }, [transcript, meetingTitle, user])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recordingRef.current = false
      if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current)
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
      }
    }
  }, [])

  return (
    <div className="max-w-4xl mx-auto p-6">
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
        </div>
      </div>

      {/* Transcript Display */}
      {transcript.length > 0 && (
        <div className="bg-white dark:bg-zinc-800 rounded-lg p-6 shadow-sm border border-zinc-200 dark:border-zinc-700">
          <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mb-4">
            Transcript
          </h2>
          <div className="space-y-4 max-h-96 overflow-y-auto">
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
  )
}
