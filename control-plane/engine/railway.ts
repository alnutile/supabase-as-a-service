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

export async function addCustomDomain(opts: {
  token: string
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
