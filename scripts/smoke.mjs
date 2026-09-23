// Smoke test: does the AUTHENTICATED app actually render?
//
// The rest of CI is blind to a crash in the app shell. Lint and typecheck are
// static; the unit suite tests pure modules and mounts one component at a time;
// and /login — the only route that renders without a session — has no Layout.
// So PR #382 shipped a blank page on every signed-in route with CI fully green:
// a hook opened a realtime channel per component, and mounting it twice
// (Layout + HomePage) threw during render and unwound the whole tree.
//
// This loads real built routes in a real browser with a stubbed Supabase and
// fails on an uncaught page error or an empty #root. It deliberately asserts
// nothing about features — it answers "did the app come up", and stays fast
// and boring so nobody learns to ignore it.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const PORT = Number(process.env.SMOKE_PORT ?? 4173)
const ORIGIN = `http://localhost:${PORT}`
// Any syntactically valid project URL; every call to it is intercepted below.
const SUPABASE_URL = 'https://example.supabase.co'
const PROJECT_REF = 'example'
const ROUTES = ['/home', '/todos', '/artifacts']

// Find a browser without downloading one: an explicit override, the browser
// preinstalled in the Claude Code image, or a Chrome/Chromium the runner
// already ships (GitHub's images have both). Tried in order so a missing
// channel degrades to the next candidate instead of failing the run.
function browserCandidates() {
  const candidates = []
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    candidates.push({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH })
  }
  if (existsSync('/opt/pw-browsers/chromium')) {
    candidates.push({ executablePath: '/opt/pw-browsers/chromium' })
  }
  candidates.push({ channel: 'chrome' }, { channel: 'chromium' }, {})
  return candidates
}

async function launchBrowser() {
  const problems = []
  for (const options of browserCandidates()) {
    try {
      return await chromium.launch(options)
    } catch (err) {
      problems.push(`${JSON.stringify(options)}: ${err.message.split('\n')[0]}`)
    }
  }
  throw new Error(`could not launch a browser. Tried:\n  ${problems.join('\n  ')}`)
}

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(ORIGIN, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`server did not come up on ${ORIGIN} within ${timeoutMs}ms`)
}

// A session shaped like the one supabase-js persists, so AuthContext believes
// it is signed in and the app renders its protected routes.
function fakeSession() {
  return {
    access_token: 'smoke.access.token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'smoke.refresh.token',
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'smoke@example.test',
      aud: 'authenticated',
      role: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  }
}

// Minimal PostgREST-shaped answers. A `maybeSingle()`/`single()` asks for an
// object via Accept, everything else wants a list — answering with the wrong
// shape makes supabase-js throw and would fail this test for the wrong reason.
function stubBody(url, accept) {
  const wantsObject = accept.includes('vnd.pgrst.object+json')
  const table = (url.split('/rest/v1/')[1] ?? '').split('?')[0]
  if (url.includes('/auth/v1/')) {
    return JSON.stringify(url.includes('/user') ? fakeSession().user : fakeSession())
  }
  if (!wantsObject) return '[]'
  switch (table) {
    case 'profiles':
      return JSON.stringify({
        id: fakeSession().user.id,
        is_admin: true,
        display_name: 'Smoke',
        avatar_url: null,
      })
    case 'workspace_settings':
      return JSON.stringify({ value: 'Smoke Corp' })
    default:
      // maybeSingle() with no row: PostgREST answers 406, supabase-js reads null.
      return 'null'
  }
}

async function run() {
  const server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT), VITE_SUPABASE_URL: SUPABASE_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverLog = ''
  server.stdout.on('data', (d) => (serverLog += d))
  server.stderr.on('data', (d) => (serverLog += d))

  let browser
  const failures = []
  try {
    await waitForServer().catch((err) => {
      throw new Error(`${err.message}\n--- server output ---\n${serverLog}`)
    })
    browser = await launchBrowser()
    const context = await browser.newContext()

    await context.route(`**://${PROJECT_REF}.supabase.co/**`, async (route) => {
      const request = route.request()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': '*',
          // Head-only count queries read the total off this header.
          'content-range': '0-0/0',
        },
        body: stubBody(request.url(), request.headers()['accept'] ?? ''),
      })
    })

    for (const route of ROUTES) {
      const page = await context.newPage()
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err))
      await page.addInitScript(
        ([ref, session]) => {
          try {
            localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(session))
          } catch {
            // a storage-less context would just render signed out
          }
        },
        [PROJECT_REF, fakeSession()],
      )

      await page.goto(`${ORIGIN}${route}`, { waitUntil: 'domcontentloaded' })
      // Let the first data round trip and its re-render settle.
      await page.waitForTimeout(2500)

      const rootSize = await page.evaluate(
        () => document.getElementById('root')?.innerHTML.length ?? -1,
      )
      const landedOn = new URL(page.url()).pathname

      if (pageErrors.length > 0) {
        failures.push(`${route}: uncaught page error: ${pageErrors[0].message}`)
      } else if (rootSize <= 0) {
        // The blank page this test exists to catch.
        failures.push(`${route}: #root is empty (rendered ${rootSize} chars)`)
      } else if (landedOn === '/login') {
        // Not the app crashing, but the test no longer proves anything.
        failures.push(`${route}: redirected to /login, so no protected route was rendered`)
      } else {
        console.log(`  ok  ${route} -> ${landedOn} (#root ${rootSize} chars)`)
      }
      await page.close()
    }
  } finally {
    if (browser) await browser.close()
    server.kill('SIGTERM')
  }

  if (failures.length > 0) {
    console.error('\nsmoke test failed:')
    for (const failure of failures) console.error(`  x  ${failure}`)
    process.exit(1)
  }
  console.log(`\nsmoke test passed (${ROUTES.length} routes)`)
}

run().catch((err) => {
  console.error('smoke test errored:', err)
  process.exit(1)
})
