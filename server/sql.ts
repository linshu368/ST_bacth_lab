import { parse, toSql, type Expr, type SelectFromStatement, type Statement } from 'pgsql-ast-parser';

type SourceKind = 'history' | 'sessions' | 'characters';
type ColumnType = 'text' | 'numeric' | 'timestamptz' | 'boolean';
type Parameter = string | number | boolean | null;

const SOURCES: Record<SourceKind, { schema: string; table: string; cte: string; columns: Record<string, ColumnType> }> = {
  history: {
    schema: 'experience', table: 'chat_history', cte: '__lab_history',
    columns: columns(
      'id user_id model user_input assistant_reply history character_id status llm_provider_name llm_finish_reason llm_model llm_generation_id llm_generation_data llm_charge_id session_id llm_billing_snapshot',
      'upstream_status deduction_rate llm_usage llm_usage_cache llm_native_tokens_cached llm_native_tokens_reasoning llm_native_tokens_completion llm_native_tokens_prompt llm_latency llm_generation_time llm_intended_deduction turn_index revision',
      'created_at llm_billing_settled_at',
    ),
  },
  sessions: {
    schema: 'experience', table: 'chat_sessions', cte: '__lab_sessions',
    columns: columns('id user_id character_id title last_message_preview', 'message_count context_window_start_turn', 'last_message_at deleted_at created_at updated_at pinned_at'),
  },
  characters: {
    schema: 'app_core', table: 'characters', cte: '__lab_characters',
    columns: columns(
      'id name description avatar_url creator_notes alternate_greetings character_book character_version creator extensions first_mes mes_example personality post_history_instructions scenario spec spec_version system_prompt tags raw_card card_hash character_persona_and_style',
      'sort_order', 'created_at updated_at archived_at last_listed_at', 'enabled is_test',
    ),
  },
};

function columns(text: string, numeric = '', timestamp = '', boolean = ''): Record<string, ColumnType> {
  return Object.fromEntries(
    [[text, 'text'], [numeric, 'numeric'], [timestamp, 'timestamptz'], [boolean, 'boolean']]
      .flatMap(([names, type]) => names.split(' ').filter(Boolean).map(name => [name, type])),
  ) as Record<string, ColumnType>;
}

function invalid(message: string): never {
  throw new Error(`SQL 无效：${message}`);
}

function onlyKeys(value: object, keys: string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(`暂不支持此 SQL 语法（${key}）`);
  }
}

/** Named parameters are tokens, never SQL literals. Quoted text and comments stay untouched. */
function bindNamedParameters(sql: string, parameters: Record<string, unknown>, values: unknown[]): string {
  let result = '';
  let i = 0;
  const bindings = new Map<string, number>();
  while (i < sql.length) {
    const start = i;
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith('/*', i)) {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) invalid('注释没有结束');
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++];
      const escapeString = quote === "'" && /[eE]/.test(sql[start - 1] ?? '')
        && (start < 2 || !/[A-Za-z0-9_$]/.test(sql[start - 2]));
      let closed = false;
      while (i < sql.length) {
        if (escapeString && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) invalid('引号没有结束');
    } else if (sql[i] === '$') {
      const delimiter = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (!delimiter) invalid('请使用 :参数名，不能直接使用 $ 序号参数');
      const end = sql.indexOf(delimiter, i + delimiter.length);
      if (end < 0) invalid('字符串没有结束');
      i = end + delimiter.length;
    } else if (sql.startsWith('::', i)) {
      i += 2;
    } else if (sql[i] === ':') {
      const name = sql.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
      if (!name) invalid('参数名格式不正确');
      if (!Object.prototype.hasOwnProperty.call(parameters, name)) invalid(`缺少参数 ${name}`);
      const value = parameters[name];
      if (!(value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) {
        invalid(`参数 ${name} 仅支持字符串、数字、布尔值或 null`);
      }
      if (typeof value === 'string' && value.length > 1000) invalid(`参数 ${name} 超过 1000 字符`);
      let position = bindings.get(name);
      if (position === undefined) {
        values.push(value as Parameter);
        position = values.length;
        bindings.set(name, position);
      }
      result += `$${position}`;
      i += name.length + 1;
      continue;
    } else {
      i++;
    }
    result += sql.slice(start, i);
  }
  return result;
}

const BINARY_OPERATORS = new Set(['AND', 'OR', '=', '!=', '>', '>=', '<', '<=', 'IN', 'NOT IN', 'LIKE', 'NOT LIKE', 'ILIKE', 'NOT ILIKE', '+', '-', '*', '/', '%', '||', '~', '~*', '!~', '!~*', '@>', '<@', '?', '?|', '?&', '#>>']);
const UNARY_OPERATORS = new Set(['+', '-', 'NOT', 'IS NULL', 'IS NOT NULL', 'IS TRUE', 'IS FALSE', 'IS NOT TRUE', 'IS NOT FALSE']);
const CAST_TYPES: Record<string, string> = {
  text: 'text', varchar: 'varchar', boolean: 'bool', bool: 'bool',
  integer: 'int4', int: 'int4', int4: 'int4', bigint: 'int8', int8: 'int8',
  numeric: 'numeric', decimal: 'numeric', real: 'float4', float4: 'float4',
  'double precision': 'float8', float8: 'float8',
  date: 'date', timestamp: 'timestamp', timestamptz: 'timestamptz',
  'timestamp with time zone': 'timestamptz', 'timestamp without time zone': 'timestamp',
  json: 'json', jsonb: 'jsonb',
};

type SourceAlias = { kind: SourceKind; alias: string; originalSchema: string; originalTable: string; explicitAlias: boolean };

function validateExpression(expr: Expr, aliases: SourceAlias[], parameterCount: number, outputAlias = false): Expr {
  switch (expr.type) {
    case 'ref': {
      onlyKeys(expr, ['type', 'name', 'table']);
      if (expr.name === '*') invalid('请明确选择 source_history_id，不能使用 *');
      if (!expr.table && outputAlias && expr.name === 'source_history_id') return expr;
      if (expr.table) onlyKeys(expr.table, ['name', 'schema']);
      const matches = aliases.filter(source => {
        const table = expr.table;
        const tableMatches = !table || (table.schema
          ? !source.explicitAlias && table.schema === source.originalSchema && table.name === source.originalTable
          : table.name === source.alias);
        return tableMatches && Object.prototype.hasOwnProperty.call(SOURCES[source.kind].columns, expr.name);
      });
      if (matches.length !== 1) invalid(`字段 ${expr.name} 不存在或不明确，请使用正确的表别名`);
      return { type: 'ref', table: { name: matches[0].alias }, name: expr.name };
    }
    case 'parameter': {
      onlyKeys(expr, ['type', 'name']);
      if (!/^\$[1-9][0-9]*$/.test(expr.name)) invalid('参数格式不正确');
      const position = Number(expr.name.slice(1));
      if (position < 2 || position > parameterCount) invalid('参数越界');
      return expr;
    }
    case 'string': case 'integer': case 'numeric': case 'boolean':
      onlyKeys(expr, ['type', 'value']);
      if ((expr.type === 'integer' || expr.type === 'numeric') && !Number.isFinite(expr.value)) invalid('数字超出支持范围');
      return expr;
    case 'null':
      onlyKeys(expr, ['type']);
      return expr;
    case 'binary':
      onlyKeys(expr, ['type', 'left', 'right', 'op']);
      if (!BINARY_OPERATORS.has(expr.op)) invalid(`不支持运算符 ${expr.op}`);
      return { ...expr, left: validateExpression(expr.left, aliases, parameterCount), right: validateExpression(expr.right, aliases, parameterCount) };
    case 'unary':
      onlyKeys(expr, ['type', 'operand', 'op']);
      if (!UNARY_OPERATORS.has(expr.op)) invalid(`不支持运算符 ${expr.op}`);
      return { ...expr, operand: validateExpression(expr.operand, aliases, parameterCount) };
    case 'list':
      onlyKeys(expr, ['type', 'expressions']);
      return { ...expr, expressions: expr.expressions.map(item => validateExpression(item, aliases, parameterCount)) };
    case 'ternary':
      onlyKeys(expr, ['type', 'op', 'value', 'lo', 'hi']);
      if (expr.op !== 'BETWEEN' && expr.op !== 'NOT BETWEEN') invalid('不支持此范围运算');
      return { ...expr, value: validateExpression(expr.value, aliases, parameterCount), lo: validateExpression(expr.lo, aliases, parameterCount), hi: validateExpression(expr.hi, aliases, parameterCount) };
    case 'cast': {
      onlyKeys(expr, ['type', 'operand', 'to']);
      onlyKeys(expr.to, ['name', 'schema', 'doubleQuoted']);
      if (expr.to.kind === 'array' || (expr.to.schema && expr.to.schema !== 'pg_catalog') || !Object.prototype.hasOwnProperty.call(CAST_TYPES, expr.to.name)) {
        invalid('仅支持常用内置数据类型转换');
      }
      return { ...expr, operand: validateExpression(expr.operand, aliases, parameterCount), to: { schema: 'pg_catalog', name: CAST_TYPES[expr.to.name] } };
    }
    case 'member':
      onlyKeys(expr, ['type', 'operand', 'op', 'member']);
      if (expr.op !== '->' && expr.op !== '->>') invalid('不支持此 JSON 运算');
      return { ...expr, operand: validateExpression(expr.operand, aliases, parameterCount) };
    case 'call': invalid('暂不允许 SQL 函数调用');
    default: invalid(`暂不支持此 SQL 表达式（${expr.type}）`);
  }
}

function sourceProjection(kind: SourceKind): string {
  const source = SOURCES[kind];
  const historyAliases: Record<string, string> = {
    session_id: 'source_session_id', character_id: 'source_character_id',
    user_id: 'source_user_id', model: 'original_model', assistant_reply: 'original_assistant_reply',
  };
  const projections = Object.entries(source.columns).map(([name, type]) => {
    const standardValue = `NULLIF(data ->> '${name}', '')`;
    const fallback = kind === 'history' ? historyAliases[name] : undefined;
    const value = fallback ? `COALESCE(${standardValue}, NULLIF(data ->> '${fallback}', ''))` : standardValue;
    const pgType = `pg_catalog.${type === 'boolean' ? 'bool' : type}`;
    const expression = type === 'text' ? value
      : `CASE WHEN pg_catalog.pg_input_is_valid(${value}, '${pgType}') THEN ${value}::${pgType} ELSE NULL END`;
    return `${expression} AS "${name}"`;
  });
  return `"${source.cte}" AS (SELECT ${projections.join(', ')} FROM public.lab_source_rows WHERE dataset_id = $1::uuid AND kind = '${kind}')`;
}

/**
 * Compile a small, read-only SQL language against one immutable CSV version.
 * The caller must still use a read-only DB transaction with a statement timeout.
 */
export function compileDatasetQuery(input: {
  datasetId: string;
  sql: string;
  parameters: Record<string, unknown>;
  sampleLimit: number;
}): { text: string; values: unknown[] } {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.datasetId)) invalid('原始数据版本 ID 格式不正确');
  if (!Number.isInteger(input.sampleLimit) || input.sampleLimit < 1 || input.sampleLimit > 500) invalid('样本数量必须在 1 到 500 之间');
  if (typeof input.sql !== 'string' || !input.sql.trim() || input.sql.length > 20_000 || input.sql.includes('\0')) invalid('SQL 为空或超过 20000 字符');
  if (!input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters)) invalid('参数必须是对象');

  const values: unknown[] = [input.datasetId];
  const boundSql = bindNamedParameters(input.sql, input.parameters, values);
  let statements: Statement[];
  try { statements = parse(boundSql); } catch { invalid('请检查 SQL 语法；当前支持 SELECT、JOIN、WHERE、ORDER BY 和 LIMIT'); }
  if (statements.length !== 1 || statements[0].type !== 'select') invalid('仅允许单条 SELECT 查询，不允许 WITH、UNION 或写入语句');
  const statement = statements[0];
  onlyKeys(statement, ['type', 'columns', 'from', 'where', 'orderBy', 'limit', 'distinct']);
  if (!statement.from?.length) invalid('必须从原始数据表中选择样本');
  if (statement.from.length > 8) invalid('最多允许连接 8 个数据表');
  if (statement.columns?.length !== 1 || statement.columns[0].alias?.name !== 'source_history_id') invalid('只允许选择一列，并命名为 source_history_id');
  onlyKeys(statement.columns[0], ['expr', 'alias']);
  onlyKeys(statement.columns[0].alias, ['name']);
  if (statement.distinct && statement.distinct !== 'all' && statement.distinct !== 'distinct') invalid('暂不支持 DISTINCT ON');

  const aliases: SourceAlias[] = [];
  const from = statement.from.map(item => {
    if (item.type !== 'table') invalid('FROM 仅支持三张原始数据表，不支持函数或子查询');
    onlyKeys(item, ['type', 'name', 'join']);
    onlyKeys(item.name, ['name', 'schema', 'alias']);
    const entry = (Object.entries(SOURCES) as [SourceKind, typeof SOURCES[SourceKind]][])
      .find(([, source]) => item.name.name === source.table && (!item.name.schema || item.name.schema === source.schema));
    if (!entry) invalid('只允许查询 experience.chat_history、experience.chat_sessions 和 app_core.characters');
    const [kind, source] = entry;
    const alias = item.name.alias ?? source.table;
    if (aliases.some(existing => existing.alias === alias)) invalid(`表别名 ${alias} 重复`);
    aliases.push({ kind, alias, originalSchema: source.schema, originalTable: source.table, explicitAlias: !!item.name.alias });
    return { ...item, name: { name: source.cte, alias } };
  });
  for (const item of from) {
    if (item.join) {
      onlyKeys(item.join, ['type', 'on', 'using']);
      if (!['INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN'].includes(item.join.type)) invalid('不支持此连接方式');
      if (item.join.using) invalid('请使用 JOIN ... ON ... 指定关联条件');
      if (item.join.on) item.join = { ...item.join, on: validateExpression(item.join.on, aliases, values.length) };
    }
  }
  const selected = validateExpression(statement.columns[0].expr, aliases, values.length);
  if (selected.type !== 'ref' || selected.name !== 'id' || !aliases.some(source => source.kind === 'history' && source.alias === selected.table?.name)) {
    invalid('source_history_id 必须来自 chat_history.id');
  }
  const query: SelectFromStatement = {
    type: 'select',
    columns: [{ expr: selected, alias: { name: 'source_history_id' } }],
    from,
  };
  if (statement.distinct) query.distinct = statement.distinct;
  if (statement.where) query.where = validateExpression(statement.where, aliases, values.length);
  if (statement.orderBy) query.orderBy = statement.orderBy.map(order => {
    onlyKeys(order, ['by', 'order', 'nulls']);
    if (order.order && !['ASC', 'DESC'].includes(order.order)) invalid('排序方向无效');
    if (order.nulls && !['FIRST', 'LAST'].includes(order.nulls)) invalid('空值排序方式无效');
    return { ...order, by: validateExpression(order.by, aliases, values.length, true) };
  });
  if (statement.limit) {
    onlyKeys(statement.limit, ['limit', 'offset']);
    query.limit = {};
    if (statement.limit.limit) query.limit.limit = validateExpression(statement.limit.limit, aliases, values.length);
    if (statement.limit.offset) query.limit.offset = validateExpression(statement.limit.offset, aliases, values.length);
  }
  const querySql = toSql.statement(query);
  values.push(input.sampleLimit + 1);
  return {
    text: `WITH ${(Object.keys(SOURCES) as SourceKind[]).map(sourceProjection).join(',\n')}\nSELECT "__lab_query"."source_history_id" FROM (${querySql}) AS "__lab_query" LIMIT $${values.length}`,
    values,
  };
}
