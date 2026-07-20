// Railway GraphQL API client — creates one service per tenant from TENANT_REPO's
// RELEASE_BRANCH with the tenant's VITE_* env vars, then attaches the
// acme.supanet.io custom domain.
//
// ⚠️ TODO(verify): the GraphQL mutation shapes below are best-effort from the
// public Railway API (https://backboard.railway.com/graphql/v2, docs at
// docs.railway.com/reference/public-api). Verify field names against the live
// schema (the API is introspectable) during the first tenant-zero run.

const RAILWAY_GQL = 'https://backboard.railway.com/graphql/v2'

async function gql<T = any>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(RAILWAY_GQL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const json = (await res.json().catch(() => ({}))) as any
  if (!res.ok || json.errors?.length) {
    throw new Error(`Railway API: ${JSON.stringify(json.errors ?? json).slice(0, 500)}`)
  }
  return json.data as T
}

export async function createService(opts: {
  token: string
  projectId: string
  environmentId: string
  name: string
  repo: string // "owner/repo"
  branch: string
  variables: Record<string, string>
}): Promise<{ serviceId: string }> {
  const data = await gql(
    opts.token,
    `mutation ($input: ServiceCreateInput!) {
       serviceCreate(input: $input) { id }
     }`,
    {
      input: {
        projectId: opts.projectId,
        name: opts.name,
        source: { repo: opts.repo },
        branch: opts.branch,
        variables: opts.variables,
      },
    },
  )
  const serviceId = data?.serviceCreate?.id
  if (!serviceId) throw new Error('Railway serviceCreate returned no id')
  return { serviceId }
}

// Pin the service's source repo+branch. serviceCreate accepts a branch field
// but the first build still tracked the repo default branch (observed on tenant
// zero), so we connect explicitly after create — this is what makes every
// tenant follow RELEASE_BRANCH.
export async function connectBranch(opts: {
  token: string
  serviceId: string
  repo: string
  branch: string
}): Promise<void> {
  await gql(
    opts.token,
    `mutation ($id: String!, $input: ServiceConnectInput!) {
       serviceConnect(id: $id, input: $input) { id }
     }`,
    { id: opts.serviceId, input: { repo: opts.repo, branch: opts.branch } },
  )
}

/** Find a service by name in the project (idempotent re-runs reuse it). */
export async function findServiceByName(
  token: string,
  projectId: string,
  name: string,
): Promise<string | undefined> {
  const data = await gql(
    token,
    `query ($id: String!) { project(id: $id) { services { edges { node { id name } } } } }`,
    { id: projectId },
  )
  const nodes: Array<{ id: string; name: string }> =
    data?.project?.services?.edges?.map((e: any) => e.node) ?? []
  return nodes.find((n) => n.name === name)?.id
}

// Enable public networking by generating a *.up.railway.app service domain.
// An API-created service has NONE by default (observed on tenant zero:
// serviceDomains was empty, the app was unreachable, and custom-domain cert
// validation hung forever) — the dashboard's "Generate domain" click is this
// mutation. Idempotent: returns the existing domain when one is already set.
export async function ensureServiceDomain(opts: {
  token: string
  projectId: string
  environmentId: string
  serviceId: string
}): Promise<{ domain: string }> {
  const existing = await gql(
    opts.token,
    `query ($p: String!, $e: String!, $s: String!) {
       domains(projectId: $p, environmentId: $e, serviceId: $s) { serviceDomains { domain } }
     }`,
    { p: opts.projectId, e: opts.environmentId, s: opts.serviceId },
  )
  const have = existing?.domains?.serviceDomains?.[0]?.domain
  if (have) return { domain: have }
  const created = await gql(
    opts.token,
    `mutation ($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
    { input: { environmentId: opts.environmentId, serviceId: opts.serviceId } },
  )
  const domain = created?.serviceDomainCreate?.domain
  if (!domain) throw new Error('serviceDomainCreate returned no domain')
  return { domain }
}

/** Existing custom domain for a service, if any (idempotent re-runs reuse it). */
export async function getCustomDomain(opts: {
  token: string
  projectId: string
  environmentId: string
  serviceId: string
  domain: string
}): Promise<
  | {
      id: string
      dnsTarget?: string
      certificateStatus?: string
      verified?: boolean
      verificationDnsHost?: string
      verificationToken?: string
    }
  | undefined
> {
  const data = await gql(
    opts.token,
    `query ($p: String!, $e: String!, $s: String!) {
       domains(projectId: $p, environmentId: $e, serviceId: $s) {
         customDomains { id domain status {
           certificateStatus verified verificationDnsHost verificationToken
           dnsRecords { requiredValue }
         } }
       }
     }`,
    { p: opts.projectId, e: opts.environmentId, s: opts.serviceId },
  )
  const hit = (data?.domains?.customDomains ?? []).find((d: any) => d.domain === opts.domain)
  if (!hit) return undefined
  return {
    id: hit.id,
    dnsTarget: hit.status?.dnsRecords?.[0]?.requiredValue,
    certificateStatus: hit.status?.certificateStatus,
    verified: Boolean(hit.status?.verified),
    // Ownership proof Railway requires as a TXT record (dashboard shows it; the
    // dnsRecords list does NOT include it — cost us 6 hours on tenant zero):
    // TXT ‹verificationDnsHost›.‹domain-zone› = ‹verificationToken›
    verificationDnsHost: hit.status?.verificationDnsHost as string | undefined,
    verificationToken: hit.status?.verificationToken as string | undefined,
  }
}

// Introspected 2026-07: CustomDomainCreateInput requires domain, environmentId,
// projectId AND serviceId (targetPort optional).
export async function addCustomDomain(opts: {
  token: string
  projectId: string
  environmentId: string
  serviceId: string
  domain: string
}): Promise<{ dnsTarget?: string }> {
  const data = await gql(
    opts.token,
    `mutation ($input: CustomDomainCreateInput!) {
       customDomainCreate(input: $input) { id status { dnsRecords { requiredValue } } }
     }`,
    {
      input: {
        projectId: opts.projectId,
        environmentId: opts.environmentId,
        serviceId: opts.serviceId,
        domain: opts.domain,
      },
    },
  )
  const target = data?.customDomainCreate?.status?.dnsRecords?.[0]?.requiredValue
  return { dnsTarget: target }
}

export async function deleteService(token: string, serviceId: string): Promise<void> {
  await gql(token, `mutation ($id: String!) { serviceDelete(id: $id) }`, { id: serviceId })
}
