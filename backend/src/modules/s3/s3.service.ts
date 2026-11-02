import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, ListBucketsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { ConnectedAccount, File, S3StorageConfig } from '@prisma/client'
import type { Response } from 'express'
import type { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { decryptText } from '../../utils/crypto.js'
import { endpointSite, listStoragePresets } from './presets.js'

type S3Config = S3StorageConfig
type FileWithAccount = File & { connectedAccount: ConnectedAccount }
type StreamOptions = { disposition?: 'inline' | 'attachment' }

function contentDisposition(type: 'inline' | 'attachment', fileName: string) {
  return `${type}; filename="${fileName.replaceAll('"', '')}"`
}

export function createS3Client(config: S3Config) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint ?? undefined,
    forcePathStyle: config.forcePathStyle || Boolean(config.endpoint),
    credentials: {
      accessKeyId: decryptText(config.accessKeyIdEncrypted),
      secretAccessKey: decryptText(config.secretAccessKeyEncrypted),
    },
  })
}

export async function getS3ConfigForAccount(accountId: string, userId?: string) {
  return prisma.s3StorageConfig.findFirstOrThrow({ where: { connectedAccountId: accountId, status: 'active', ...(userId ? { userId } : {}) } })
}

/**
 * Turn an S3 SDK failure into something a person can act on.
 *
 * A bad bucket name, a wrong region or a key without permission all used to reach
 * the browser as `500 Client network socket disconnected…`, which says nothing
 * about the cause. Each branch below names the culprit and the fix.
 */
export function describeS3Error(error: unknown, context: { bucket: string; endpoint: string | null; region: string }): { code: string; message: string } {
  const err = error as { name?: string; Code?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number } } | null
  const name = err?.name ?? err?.Code ?? err?.code ?? 'UnknownError'
  const raw = err?.message ?? String(error)
  const where = `${context.bucket} at ${context.endpoint ?? `AWS ${context.region}`}`

  if (/InvalidAccessKeyId|SignatureDoesNotMatch|UnauthorizedAccess|InvalidToken/i.test(name)) {
    return {
      code: 'S3_AUTH_FAILED',
      message: `The access key was rejected by ${where}. Check the key ID and secret (a secret cannot be viewed again in most consoles - create a new key if unsure).`,
    }
  }
  if (/NoSuchBucket/i.test(name)) {
    return { code: 'S3_BUCKET_NOT_FOUND', message: `The bucket "${context.bucket}" does not exist on ${context.endpoint ?? `AWS ${context.region}`}. Create it in the provider's console, then connect again.` }
  }
  if (/AccessDenied|Forbidden|403/.test(name) || err?.$metadata?.httpStatusCode === 403) {
    return {
      code: 'S3_ACCESS_DENIED',
      message: `The credentials work but are not allowed to read the bucket "${context.bucket}". Grant the key list/read/write permission on that bucket.`,
    }
  }
  if (/PermanentRedirect|Redirect|301|AuthorizationHeaderMalformed|IllegalLocationConstraint/i.test(name)) {
    return {
      code: 'S3_WRONG_REGION',
      message: `The bucket "${context.bucket}" lives in a different region than "${context.region}". Copy the region from the provider's console and try again.`,
    }
  }
  if (/Deserialization error|is not expected|UnexpectedEndOfRequestContent|InvalidXml|not valid XML/i.test(`${name} ${raw}`)) {
    // The endpoint answered, but not with S3 XML: a REST/dashboard URL was used as
    // the S3 host. The SDK's own message ("char '{' is not expected.:1:1") names the
    // symptom and hides the cause.
    const dbrij = /dbrij/i.test(context.endpoint ?? '')
    return {
      code: 'S3_ENDPOINT_NOT_S3',
      message: `${context.endpoint ?? 'The endpoint'} answered with JSON or HTML instead of S3 XML, so it is the provider's API/dashboard URL rather than its S3 API host. ${dbrij ? 'For Dbrij use https://s3.dbrij.com.' : 'Copy the endpoint that starts with "s3." from the provider console.'}`,
    }
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|TimeoutError|net::|socket|EPROTO|CERT/i.test(`${name} ${raw}`)) {
    return {
      code: 'S3_ENDPOINT_UNREACHABLE',
      message: `Could not reach ${context.endpoint ?? `AWS ${context.region}`}. Check the endpoint URL (it must be the S3 API URL, with no bucket name in it) and that this deployment has outbound internet access.`,
    }
  }
  return {
    code: 'S3_CONNECTION_FAILED',
    message: `The storage provider rejected the connection to ${where}: ${name}${raw && raw !== name ? ` - ${raw}` : ''}`,
  }
}

/**
 * The buckets these credentials can see.
 *
 * A provider that publishes `AWS_*` variables usually publishes the endpoint, the
 * region and the keys - but not the bucket, because the bucket is not part of an
 * AWS credential. Rather than making the user hunt for the name, ask the account:
 * one bucket means there is nothing to choose, several are reported by name.
 */
export async function listS3BucketNames(credentials: {
  region: string
  endpoint: string | null
  forcePathStyle: boolean
  accessKeyId: string
  secretAccessKey: string
}): Promise<string[]> {
  const client = new S3Client({
    region: credentials.region,
    endpoint: credentials.endpoint ?? undefined,
    forcePathStyle: credentials.forcePathStyle || Boolean(credentials.endpoint),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  })
  const response = await client.send(new ListBucketsCommand({}))
  return (response.Buckets ?? [])
    .map((bucket) => bucket.Name)
    .filter((name): name is string => Boolean(name))
}

export async function testS3Connection(config: S3Config) {
  const client = createS3Client(config)
  await client.send(new HeadBucketCommand({ Bucket: config.bucket }))
}

function safeFileName(name: string) {
  return name.replace(/[\\/]+/g, '-').replace(/[\u0000-\u001f\u007f]+/g, '').slice(0, 180) || 'file'
}

export function buildS3ObjectKey(config: Pick<S3Config, 'prefix'>, userId: string, fileId: string, fileName: string) {
  return `${config.prefix.replace(/^\/+|\/+$/g, '')}/${userId}/${fileId}/${safeFileName(fileName)}`
}

export async function uploadS3Object(config: S3Config, key: string, body: NodeJS.ReadableStream, mimeType: string) {
  const client = createS3Client(config)
  await new Upload({
    client,
    params: { Bucket: config.bucket, Key: key, Body: body as Readable, ContentType: mimeType },
  }).done()
}

export async function deleteS3Object(file: FileWithAccount) {
  const config = await getS3ConfigForAccount(file.connectedAccountId)
  const client = createS3Client(config)
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: file.providerFileId }))
}

/**
 * Adopt a quota cap that was declared in the environment after the account was
 * connected.
 *
 * IDrive E2 and Dbrij report no quota, so an account connected before its cap
 * existed keeps reading "Unlimited" - and the cap lives in the environment, not in
 * the form. Matching on the endpoint's site (and the bucket when the preset names
 * one) lets a redeploy fix an existing account without disconnecting it.
 */
async function adoptDeclaredQuota(config: S3Config) {
  if (config.quotaBytes !== null) return config
  const preset = listStoragePresets().find((entry) =>
    entry.ready
    && entry.quotaBytes
    && endpointSite(entry.endpoint) === endpointSite(config.endpoint)
    && (!entry.bucket || entry.bucket === config.bucket))
  if (!preset?.quotaBytes) return config
  const quotaBytes = BigInt(preset.quotaBytes)
  await prisma.s3StorageConfig.update({ where: { connectedAccountId: config.connectedAccountId }, data: { quotaBytes } })
  return { ...config, quotaBytes }
}

export async function syncS3Quota(accountId: string) {
  const stored = await getS3ConfigForAccount(accountId)
  const config = await adoptDeclaredQuota(stored)
  const client = createS3Client(config)
  let usedBytes = 0n
  let continuationToken: string | undefined
  do {
    const response = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, ContinuationToken: continuationToken }))
    for (const object of response.Contents ?? []) usedBytes += BigInt(object.Size ?? 0)
    continuationToken = response.NextContinuationToken
  } while (continuationToken)

  return prisma.storageAccount.upsert({
    where: { connectedAccountId: accountId },
    create: {
      connectedAccountId: accountId,
      totalBytes: config.quotaBytes,
      usedBytes,
      availableBytes: config.quotaBytes === null ? null : config.quotaBytes - usedBytes,
      lastSyncedAt: new Date(),
    },
    update: {
      totalBytes: config.quotaBytes,
      usedBytes,
      availableBytes: config.quotaBytes === null ? null : config.quotaBytes - usedBytes,
      lastSyncedAt: new Date(),
    },
  })
}

export async function streamS3File(file: FileWithAccount, range: string | undefined, res: Response, options: StreamOptions = {}) {
  const config = await getS3ConfigForAccount(file.connectedAccountId)
  const client = createS3Client(config)
  const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId, Range: range }))

  res.status(response.ContentRange ? 206 : 200)
  res.setHeader('Content-Type', response.ContentType ?? file.mimeType)
  res.setHeader('Accept-Ranges', 'bytes')
  if (options.disposition) res.setHeader('Content-Disposition', contentDisposition(options.disposition, file.name))
  if (response.ContentLength !== undefined) res.setHeader('Content-Length', response.ContentLength.toString())
  if (response.ContentRange) res.setHeader('Content-Range', response.ContentRange)

  const body = response.Body as Readable | undefined
  if (!body) return res.end()
  return body.pipe(res)
}
