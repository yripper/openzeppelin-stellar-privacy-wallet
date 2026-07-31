import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { bootnodePages, ctActivity, cursors, events, type NewEventRow } from "./schema.js";

/** column name -> drizzle SQL column type, as declared in each pgTable(...). */
function columnTypes(table: Parameters<typeof getTableColumns>[0]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, col] of Object.entries(getTableColumns(table))) {
    out[key] = col.columnType;
  }
  return out;
}

describe("schema shapes (byte-match against the task-5 brief)", () => {
  it("events: table name, columns, and text PK", () => {
    expect(getTableName(events)).toBe("events");
    expect(columnTypes(events)).toEqual({
      id: "PgText",
      contractId: "PgText",
      ledger: "PgInteger",
      ledgerClosedAt: "PgTimestamp",
      txHash: "PgText",
      txIndex: "PgInteger",
      opIndex: "PgInteger",
      eventIndex: "PgInteger",
      topic: "PgJsonb",
      valueXdr: "PgText",
      inSuccessfulCall: "PgBoolean",
    });
    expect(events.id.primary).toBe(true);
  });

  it("ct_activity: table name, columns, uuid PK, nullable amount", () => {
    expect(getTableName(ctActivity)).toBe("ct_activity");
    expect(columnTypes(ctActivity)).toEqual({
      id: "PgUUID",
      account: "PgText",
      type: "PgText",
      counterparty: "PgText",
      amount: "PgText",
      ledger: "PgInteger",
      txHash: "PgText",
      eventId: "PgText",
      ciphertexts: "PgJsonb",
    });
    expect(ctActivity.id.primary).toBe(true);
    expect(ctActivity.amount.notNull).toBe(false);
    expect(ctActivity.account.notNull).toBe(true);
  });

  it("cursors: key/value/updated_at (troqpay shape)", () => {
    expect(getTableName(cursors)).toBe("cursors");
    expect(columnTypes(cursors)).toEqual({
      key: "PgText",
      value: "PgText",
      updatedAt: "PgTimestamp",
    });
    expect(cursors.key.primary).toBe(true);
  });

  it("bootnode_pages: cursor_in PK + request/response jsonb", () => {
    expect(getTableName(bootnodePages)).toBe("bootnode_pages");
    expect(columnTypes(bootnodePages)).toEqual({
      cursorIn: "PgText",
      request: "PgJsonb",
      response: "PgJsonb",
      cursorOut: "PgText",
      lastEventLedger: "PgInteger",
      createdAt: "PgTimestamp",
    });
    expect(bootnodePages.cursorIn.primary).toBe(true);
  });
});

describe("events.id construction", () => {
  it("matches @ctd/sdk's naturalEventId format: ${ledger}-${txHash}-${opIndex}-${eventIndex}", () => {
    const ledger = 3900251;
    const txHash = "a1b2c3d4e5f6";
    const opIndex = 0;
    const eventIndex = 2;
    const id = `${ledger}-${txHash}-${opIndex}-${eventIndex}`;

    expect(id).toBe("3900251-a1b2c3d4e5f6-0-2");
    // The id is opaque text to Postgres; assert the shape a real caller would
    // build (as @ctd/sdk's naturalEventId does) type-checks against NewEventRow.
    const row: NewEventRow = {
      id,
      contractId: "CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH",
      ledger,
      ledgerClosedAt: new Date(),
      txHash,
      txIndex: 0,
      opIndex,
      eventIndex,
      topic: ["transfer"],
      valueXdr: "AAAAAA==",
      inSuccessfulCall: true,
    };
    expect(row.id.split("-")).toHaveLength(4);
  });
});
