// office-worker — the OfficeCLI capability worker. Polls agent_jobs for
// `capability = office` jobs and runs the allow-listed document operations.
import { startWorker } from '@supanet/worker-shared'
import { convertDocument, createDocx, inspectDocument, renderDocument } from './operations.js'

const VERSION = '0.1.0'

startWorker({
  capability: 'office',
  version: VERSION,
  handlers: {
    'office.inspect_document': inspectDocument,
    'office.render_document': renderDocument,
    'office.create_docx': createDocx,
    'office.convert_document': convertDocument,
  },
}).catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', worker: 'office', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
