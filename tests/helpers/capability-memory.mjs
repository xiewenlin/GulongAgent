import { ObjectId } from "mongodb";

const scalar = (value) => value instanceof ObjectId ? String(value) : value instanceof Date ? +value : value;
const equal = (left, right) => scalar(left) === scalar(right) || (left == null && right == null);
function clone(value) {
  if (value instanceof ObjectId) return new ObjectId(String(value));
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}
function nested(row, key) {
  if (!key || row == null) return row;
  if (Array.isArray(row)) return row.flatMap((item) => nested(item, key));
  const [part, ...remaining] = key.split(".");
  return nested(row[part], remaining.join("."));
}
function matches(row, filter = {}) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((entry) => matches(row, entry));
    if (key === "$and") return value.every((entry) => matches(row, entry));
    if (key === "$nor") return !value.some((entry) => matches(row, entry));
    const actual = nested(row, key);
    const candidates = Array.isArray(actual) ? actual : [actual];
    if (!value || typeof value !== "object" || value instanceof ObjectId || value instanceof Date) return candidates.some((item) => equal(item, value));
    return Object.entries(value).every(([op, expected]) => {
      if (op === "$eq") return candidates.some((item) => equal(item, expected));
      if (op === "$ne") return !candidates.some((item) => equal(item, expected));
      if (op === "$in") return candidates.some((item) => expected.some((entry) => equal(item, entry)));
      if (op === "$nin") return !candidates.some((item) => expected.some((entry) => equal(item, entry)));
      if (op === "$exists") return (actual !== undefined) === expected;
      if (op === "$options") return true;
      if (op === "$regex") return candidates.some((item) => typeof item === "string" && new RegExp(expected, value.$options || "").test(item));
      if (op === "$gte") return candidates.some((item) => scalar(item) >= scalar(expected));
      if (op === "$gt") return candidates.some((item) => scalar(item) > scalar(expected));
      if (op === "$lte") return candidates.some((item) => scalar(item) <= scalar(expected));
      if (op === "$lt") return candidates.some((item) => scalar(item) < scalar(expected));
      if (op === "$not") return !matches({ value: actual }, { value: expected });
      if (op === "$elemMatch") return Array.isArray(actual) && actual.some((item) => matches(item, expected));
      throw new Error(`Memory Mongo fixture does not implement ${op}`);
    });
  });
}
function assign(row, key, value, unset = false) {
  const parts = key.split(".");
  const last = parts.pop();
  let target = row;
  for (const part of parts) target = target[part] ||= {};
  if (unset) delete target[last]; else target[last] = clone(value);
}
function mutate(row, update, inserting = false) {
  if (inserting) for (const [key, value] of Object.entries(update.$setOnInsert || {})) assign(row, key, value);
  for (const [key, value] of Object.entries(update.$set || {})) assign(row, key, value);
  for (const key of Object.keys(update.$unset || {})) assign(row, key, null, true);
  for (const [key, value] of Object.entries(update.$inc || {})) assign(row, key, (nested(row, key) || 0) + value);
  for (const [key, value] of Object.entries(update.$addToSet || {})) {
    const existing = nested(row, key);
    if (existing !== undefined && !Array.isArray(existing)) throw new Error("$addToSet requires an array field");
    const values = existing || [];
    for (const item of value && typeof value === "object" && "$each" in value ? value.$each : [value]) {
      if (!values.some((previous) => equal(previous, item))) values.push(clone(item));
    }
    assign(row, key, values);
  }
  const supported = new Set(["$setOnInsert", "$set", "$unset", "$inc", "$addToSet"]);
  for (const key of Object.keys(update)) if (!supported.has(key)) throw new Error(`Memory Mongo fixture does not implement ${key}`);
}

/** Linearizable in-memory Mongo subset: no async yield between CAS match/write.
 * Reads return detached snapshots, so version-CAS tests cannot pass by mutating
 * the same JavaScript object held by both caller and collection.
 */
export function createCapabilityMemoryCollection(initialRows = []) {
  const rows = initialRows.map(clone);
  const insert = (document) => {
    const row = { ...clone(document), _id: document._id ?? new ObjectId() };
    if (rows.some((item) => equal(item._id, row._id))) throw Object.assign(new Error("duplicate _id"), { code: 11000 });
    rows.push(row);
    return row;
  };
  const upsert = (filter, update) => {
    const document = Object.fromEntries(Object.entries(filter).filter(([key, value]) => !key.startsWith("$") && (!value || typeof value !== "object" || value instanceof ObjectId || value instanceof Date)));
    mutate(document, update, true);
    return insert(document);
  };
  return {
    rows,
    async findOne(filter = {}) { return clone(rows.find((row) => matches(row, filter)) || null); },
    find(filter = {}) {
      let values = rows.filter((row) => matches(row, filter));
      return {
        sort(order) { values.sort((left, right) => { for (const [key, direction] of Object.entries(order)) { if (scalar(nested(left, key)) < scalar(nested(right, key))) return -direction; if (scalar(nested(left, key)) > scalar(nested(right, key))) return direction; } return 0; }); return this; },
        limit(count) { values = values.slice(0, count); return this; },
        skip(count) { values = values.slice(count); return this; },
        async toArray() { return values.map(clone); },
      };
    },
    async countDocuments(filter = {}) { return rows.filter((row) => matches(row, filter)).length; },
    async insertOne(document) { return { insertedId: insert(document)._id }; },
    async updateOne(filter, update, options = {}) {
      const row = rows.find((entry) => matches(entry, filter));
      if (row) { mutate(row, update); return { matchedCount: 1, modifiedCount: 1 }; }
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0 };
      const inserted = upsert(filter, update);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: inserted._id };
    },
    async updateMany(filter, update) {
      const matching = rows.filter((row) => matches(row, filter));
      matching.forEach((row) => mutate(row, update));
      return { matchedCount: matching.length, modifiedCount: matching.length };
    },
    async findOneAndUpdate(filter, update, options = {}) {
      let row = rows.find((entry) => matches(entry, filter));
      const before = clone(row || null);
      if (row) mutate(row, update);
      else if (options.upsert) row = upsert(filter, update);
      return options.returnDocument === "after" ? clone(row || null) : before;
    },
  };
}
