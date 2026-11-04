/**
 * A small in-memory stand-in for PrismaClient, used by the end-to-end API test.
 *
 * The test boots the *real* Express application; only this module is fake. It
 * implements exactly the query surface the API routes use (equality filters, the
 * `in`/`not`/`contains`/`startsWith`/`gt`/`gte`/`lt`/`lte` operators, `OR`/`AND`
 * /`NOT`, `orderBy`, `take`/`skip`/`cursor`, `select` and `include`), so the
 * routing, authentication, validation, provider calls and serialisation under
 * test are the production ones.
 *
 * This file is test-only. It is never imported by application code.
 */

const MODELS = [
  'user',
  'apiKey',
  'apiKeyRateLimitWindow',
  'uploadRoutingPolicy',
  'connectedAccount',
  's3StorageConfig',
  'storageAccount',
  'file',
  'folder',
  'uploadSession',
  'auditLog',
  'fileShare',
  'providerConfig',
  // Sessions are needed by any test that signs in with a dashboard token rather
  // than an API key; `requireAuth` looks one up on every request.
  'userSession',
  // Coming Soon / HXP growth module.
  'comingSoonFeature',
  'featureVote',
  'pointsRule',
  'pointsLedgerEntry',
  'song',
]

/** Relation name -> how to reach it from a row of `model`. */
const RELATIONS = {
  comingSoonFeature: {
    /** `_count.select.votes` - how many accounts voted for this card. */
    _count: { model: 'featureVote', kind: 'hasMany', foreignKey: 'featureId', counts: 'votes' },
  },
  file: {
    folder: { model: 'folder', kind: 'belongsTo', foreignKey: 'folderId' },
    connectedAccount: { model: 'connectedAccount', kind: 'belongsTo', foreignKey: 'connectedAccountId' },
  },
  connectedAccount: {
    storageAccount: { model: 'storageAccount', kind: 'hasOne', foreignKey: 'connectedAccountId' },
    s3StorageConfig: { model: 's3StorageConfig', kind: 'hasOne', foreignKey: 'connectedAccountId' },
  },
  folder: {
    connectedAccount: { model: 'connectedAccount', kind: 'belongsTo', foreignKey: 'connectedAccountId' },
  },
}

const OPERATORS = new Set(['in', 'notIn', 'not', 'contains', 'startsWith', 'endsWith', 'gt', 'gte', 'lt', 'lte', 'equals', 'mode'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && typeof value !== 'bigint'
}

function looseEqual(a, b) {
  if (a === b) return true
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    try {
      return BigInt(a) === BigInt(b)
    } catch {
      return false
    }
  }
  if (a === null && b === undefined) return true
  if (a === undefined && b === null) return true
  return false
}

function compareValues(a, b) {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const left = BigInt(a)
    const right = BigInt(b)
    return left < right ? -1 : left > right ? 1 : 0
  }
  if (a instanceof Date || b instanceof Date) {
    const left = a instanceof Date ? a.getTime() : Number(a)
    const right = b instanceof Date ? b.getTime() : Number(b)
    return left < right ? -1 : left > right ? 1 : 0
  }
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  return String(a).localeCompare(String(b))
}

function matchOperator(value, operator, operand) {
  switch (operator) {
    case 'in':
      return Array.isArray(operand) && operand.some((entry) => looseEqual(value, entry))
    case 'notIn':
      return Array.isArray(operand) && !operand.some((entry) => looseEqual(value, entry))
    case 'not':
      return !matchesWhere({ value }, { value: operand })
    case 'equals':
      return looseEqual(value, operand)
    case 'contains':
      return String(value ?? '').includes(String(operand))
    case 'startsWith':
      return String(value ?? '').startsWith(String(operand))
    case 'endsWith':
      return String(value ?? '').endsWith(String(operand))
    case 'gt':
      return compareValues(value, operand) > 0
    case 'gte':
      return compareValues(value, operand) >= 0
    case 'lt':
      return compareValues(value, operand) < 0
    case 'lte':
      return compareValues(value, operand) <= 0
    case 'mode':
      return true
    default:
      throw new Error(`fake-prisma: unsupported operator "${operator}"`)
  }
}

function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'OR') return condition.some((clause) => matchesWhere(row, clause))
    if (field === 'AND') return condition.every((clause) => matchesWhere(row, clause))
    if (field === 'NOT') return !matchesWhere(row, condition)

    // A compound unique key reaches `findUnique` as
    // `{ featureId_userId: { featureId, userId } }` - not a column, so there is
    // no row value to compare. Flatten it into the fields it is made of.
    if (isPlainObject(condition) && !Object.keys(condition).some((key) => OPERATORS.has(key)) && row?.[field] === undefined) {
      if (Object.keys(condition).every((key) => Object.hasOwn(row ?? {}, key))) {
        return Object.entries(condition).every(([key, expected]) => looseEqual(row[key], expected))
      }
    }

    const value = row?.[field]
    if (isPlainObject(condition)) {
      const keys = Object.keys(condition)
      // A composite unique input such as { apiKeyId_windowStart: {...} } has no
      // operator keys: compare every field for equality instead.
      if (keys.length > 0 && keys.some((key) => OPERATORS.has(key))) {
        return keys.every((key) => matchOperator(value, key, condition[key]))
      }
      return keys.every((key) => looseEqual(value?.[key], condition[key]))
    }
    return looseEqual(value, condition)
  })
}

function sortRows(rows, orderBy) {
  if (!orderBy) return rows
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy]
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [field, direction] of Object.entries(spec)) {
        const cmp = compareValues(a?.[field], b?.[field])
        if (cmp !== 0) return direction === 'desc' ? -cmp : cmp
      }
    }
    return 0
  })
}

export function createFakePrisma() {
  /** @type {Record<string, Array<Record<string, unknown>>>} */
  const store = Object.fromEntries(MODELS.map((model) => [model, []]))
  const now = () => new Date()

  function rows(model) {
    if (!store[model]) throw new Error(`fake-prisma: unknown model "${model}"`)
    return store[model]
  }

  function resolveRelation(model, row, relation, spec) {
    const definition = RELATIONS[model]?.[relation]
    if (!definition) throw new Error(`fake-prisma: unknown relation "${model}.${relation}"`)
    const found =
      definition.kind === 'belongsTo'
        ? rows(definition.model).find((candidate) => candidate.id === row?.[definition.foreignKey])
        : rows(definition.model).find((candidate) => candidate[definition.foreignKey] === row?.id)
    if (!found) return null
    return spec === true ? { ...found } : project(definition.model, found, spec ?? {})
  }

  /**
   * `_count: { select: { votes: true } }` - a relation count, not a column.
   *
   * It has to be materialised into the row the way Prisma presents it, because
   * the code under test reads `feature._count.votes` directly.
   */
  function resolveCount(model, row, spec) {
    const definition = RELATIONS[model]?._count
    if (!definition) throw new Error(`fake-prisma: unknown relation "${model}._count"`)
    const out = {}
    for (const [key, value] of Object.entries(spec)) {
      if (!value) continue
      out[key] = rows(definition.model).filter((candidate) => candidate[definition.foreignKey] === row?.id).length
    }
    return out
  }

  function project(model, row, { select, include }) {
    if (select) {
      const out = {}
      for (const [field, value] of Object.entries(select)) {
        if (value === true) out[field] = row[field]
        else if (field === '_count') out[field] = resolveCount(model, row, value.select ?? value)
        else if (isPlainObject(value)) out[field] = resolveRelation(model, row, field, value)
      }
      return out
    }
    const out = { ...row }
    if (include) {
      for (const [relation, spec] of Object.entries(include)) {
        if (relation === '_count') {
          out._count = resolveCount(model, row, spec?.select ?? spec)
          continue
        }
        if (spec === true) {
          const definition = RELATIONS[model]?.[relation]
          const found =
            definition.kind === 'belongsTo'
              ? rows(definition.model).find((candidate) => candidate.id === row?.[definition.foreignKey])
              : rows(definition.model).find((candidate) => candidate[definition.foreignKey] === row?.id)
          out[relation] = found ? { ...found } : null
        } else {
          out[relation] = resolveRelation(model, row, relation, spec)
        }
      }
    }
    return out
  }

  function filter(model, args = {}) {
    let matched = rows(model).filter((row) => matchesWhere(row, args.where))
    matched = sortRows(matched, args.orderBy)

    if (args.cursor) {
      const cursorId = Object.values(args.cursor)[0]
      const index = matched.findIndex((row) => row.id === cursorId)
      if (index >= 0) matched = matched.slice(index + (args.skip ?? 0))
      return matched
    }
    if (args.skip) matched = matched.slice(args.skip)
    if (typeof args.take === 'number') matched = matched.slice(0, Math.abs(args.take))
    if (typeof args.take === 'number' && args.take < 0) matched = matched.slice(args.take)
    return matched
  }

  function insert(model, data) {
    const row = {
      ...data,
      id: data.id ?? `${model}-${Math.random().toString(36).slice(2, 10)}`,
      createdAt: data.createdAt ?? now(),
      updatedAt: data.updatedAt ?? now(),
    }
    rows(model).push(row)
    return row
  }

  function delegate(model) {
    return {
      async create({ data, select, include } = {}) {
        const row = insert(model, data)
        return project(model, row, { select, include })
      },
      async findUnique({ where, select, include } = {}) {
        const row = rows(model).find((candidate) => matchesWhere(candidate, where))
        return row ? project(model, row, { select, include }) : null
      },
      async findUniqueOrThrow(args = {}) {
        const row = await this.findUnique(args)
        if (!row) throw new Error(`fake-prisma: no ${model} found`)
        return row
      },
      async findFirst(args = {}) {
        const row = filter(model, args)[0]
        return row ? project(model, row, args) : null
      },
      async findFirstOrThrow(args = {}) {
        const row = await this.findFirst(args)
        if (!row) throw new Error(`fake-prisma: no ${model} found`)
        return row
      },
      async findMany(args = {}) {
        return filter(model, args).map((row) => project(model, row, args))
      },
      async update({ where, data, select, include } = {}) {
        const row = rows(model).find((candidate) => matchesWhere(candidate, where))
        if (!row) throw new Error(`fake-prisma: no ${model} to update`)
        Object.assign(row, data, { updatedAt: now() })
        return project(model, row, { select, include })
      },
      async updateMany({ where, data } = {}) {
        const matched = rows(model).filter((candidate) => matchesWhere(candidate, where))
        for (const row of matched) Object.assign(row, data, { updatedAt: now() })
        return { count: matched.length }
      },
      async upsert({ where, create, update, select, include } = {}) {
        const existing = rows(model).find((candidate) => matchesWhere(candidate, where))
        if (!existing) {
          const row = insert(model, create)
          return project(model, row, { select, include })
        }
        Object.assign(existing, update, { updatedAt: now() })
        return project(model, existing, { select, include })
      },
      async delete({ where } = {}) {
        const index = rows(model).findIndex((candidate) => matchesWhere(candidate, where))
        if (index < 0) throw new Error(`fake-prisma: no ${model} to delete`)
        return { ...rows(model).splice(index, 1)[0] }
      },
      async deleteMany({ where } = {}) {
        const matched = rows(model).filter((candidate) => matchesWhere(candidate, where))
        for (const row of matched) rows(model).splice(rows(model).indexOf(row), 1)
        return { count: matched.length }
      },
      async count({ where } = {}) {
        return rows(model).filter((candidate) => matchesWhere(candidate, where)).length
      },
      /**
       * `_sum` / `_count` over a filtered set. The HXP balance is a SUM over the
       * ledger, so a test that could not aggregate would have to reimplement the
       * thing under test.
       */
      async aggregate({ where, _sum, _count } = {}) {
        const matched = rows(model).filter((candidate) => matchesWhere(candidate, where))
        const result = {}
        if (_sum) {
          result._sum = {}
          for (const field of Object.keys(_sum)) {
            if (!_sum[field]) continue
            result._sum[field] = matched.reduce((total, row) => total + Number(row[field] ?? 0), 0)
          }
        }
        if (_count) {
          result._count = typeof _count === 'object' ? { _all: matched.length } : matched.length
        }
        return result
      },
      /** Groups by one or more fields, summing/counting each bucket. */
      async groupBy({ by, where, _sum, _count } = {}) {
        const fields = Array.isArray(by) ? by : [by]
        const buckets = new Map()
        for (const row of rows(model).filter((candidate) => matchesWhere(candidate, where))) {
          const key = fields.map((field) => String(row[field])).join('\u0000')
          if (!buckets.has(key)) {
            const seed = {}
            for (const field of fields) seed[field] = row[field]
            buckets.set(key, { ...seed, rows: [] })
          }
          buckets.get(key).rows.push(row)
        }
        return [...buckets.values()].map((bucket) => {
          const output = {}
          for (const field of fields) output[field] = bucket[field]
          if (_sum) {
            output._sum = {}
            for (const field of Object.keys(_sum)) {
              if (!_sum[field]) continue
              output._sum[field] = bucket.rows.reduce((total, row) => total + Number(row[field] ?? 0), 0)
            }
          }
          if (_count) output._count = typeof _count === 'object' ? { _all: bucket.rows.length } : bucket.rows.length
          return output
        })
      },
      /**
       * `distinct` is only used for "which collections exist", so a field-level
       * de-duplication is enough here.
       */
      async findManyDistinct(args = {}) {
        return this.findMany(args)
      },
    }
  }

  const client = {}
  for (const model of MODELS) client[model] = delegate(model)

  return Object.assign(client, {
    /** Raw rows, for seeding and assertions. */
    _store: store,
    $queryRawUnsafe(sql) {
      if (/^\s*SELECT\s+1\b/i.test(String(sql))) return Promise.resolve([{ 1: 1 }])
      if (String(sql).includes('_prisma_migrations')) return Promise.resolve([{ n: 17 }])
      return Promise.reject(new Error(`fake-prisma: unexpected raw query: ${sql}`))
    },
    $transaction(callback) {
      return Promise.resolve(typeof callback === 'function' ? callback(client) : callback)
    },
    $connect() {
      return Promise.resolve()
    },
    $disconnect() {
      return Promise.resolve()
    },
  })
}
