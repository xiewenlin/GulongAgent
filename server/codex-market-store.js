import { getCollection, getDb, withDatabaseTransaction } from "./db.js";
import { marketError } from "./codex-market-pricing.js";

let indexes;

export async function ensureCodexMarketStore() {
  const db = await getDb();
  const hello = await db.command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") throw marketError("TRANSACTIONAL_STORE_REQUIRED", "Codex 共享订单需要支持事务的数据库，收费已停用", 503);
  if (!indexes) indexes = (async () => {
    await Promise.all([
      db.collection("codexMarketQuotes").createIndex({ ownerId: 1, requestId: 1 }, { unique: true }),
      db.collection("codexMarketTasks").createIndex({ ownerId: 1, requestId: 1 }, { unique: true }),
      db.collection("codexMarketTasks").createIndex({ quoteId: 1 }, { unique: true }),
      db.collection("codexMarketTasks").createIndex({ status: 1, model: 1, createdAt: 1 }),
      db.collection("codexMarketTasks").createIndex({ status: 1, deadlineAt: 1 }),
      db.collection("codexMarketNodes").createIndex({ ownerId: 1, nodeId: 1 }, { unique: true }),
      db.collection("codexMarketNodes").createIndex({ tokenHash: 1 }, { unique: true }),
      db.collection("codexMarketCallbacks").createIndex({ taskId: 1, claimId: 1, eventId: 1 }, { unique: true }),
      db.collection("codexMarketLedger").createIndex({ key: 1 }, { unique: true }),
      db.collection("codexMarketLedger").createIndex({ ownerId: 1, createdAt: -1 }),
      // Reuse the wallet index name installed by the platform database
      // bootstrap. MongoDB reports IndexOptionsConflict when an equivalent
      // key/options pair is requested under a different implicit name.
      db.collection("wallets").createIndex({ ownerId: 1 }, { unique: true, name: "uniq_wallet_owner" }),
    ]);
  })().catch((error) => { indexes = null; throw error; });
  await indexes;
}

export const codexMarketStorage = {
  getCollection,
  ensureStore: ensureCodexMarketStore,
  transaction: withDatabaseTransaction,
};
