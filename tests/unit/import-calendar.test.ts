import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ConfigFile } from "../../src/config/ConfigFile.ts";
import { applyImport, parseImport, splitCsvLine, type ImportDefaults } from "../../src/config/importTargets.ts";
import { toIcs } from "../../src/core/calendar.ts";
import { queryNtp } from "../../src/core/ntp.ts";
import { tempDir } from "../helpers/fakes.ts";

const defaults: ImportDefaults = {
  mode: "notify-only",
  currency: "PLN",
  registrars: [],
  sources: ["rdap"],
  timezone: "Europe/Warsaw",
  preWindowSeconds: 600,
  postWindowSeconds: 900,
};
const none = { ids: new Set<string>(), domains: new Map<string, string>() };

describe("bulk import", () => {
  it("reads plain lines with optional local drop times", () => {
    const rows = parseImport("# my list\nSklep-Kawowy.PL 2026-10-05 10:00\nexample.com\n", defaults, none, false);
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[0]!.id, rows[0]!.domain, rows[0]!.expectedAt], ["sklep-kawowy-pl", "sklep-kawowy.pl", "2026-10-05T08:00:00.000Z"]);
    assert.equal(rows[1]!.expectedAt, undefined);
    assert.equal(rows[1]!.action, "create");
  });

  it("reads CSV with aliases, quotes and semicolons", () => {
    assert.deepEqual(splitCsvLine('a,"b, c",d', ","), ["a", "b, c", "d"]);
    const csv = 'Domain;Drop;Mode;Budget;Registrars\nshop.pl;2026-10-05T10:00:00Z;auto-buy;25;ovh-main\n"quoted.pl";;confirm;;';
    const rows = parseImport(csv, defaults, none, false);
    const t = rows[0]!.target as { registration: { mode: string; providers: string[]; budget: { maxRegistrationPrice: number } } };
    assert.deepEqual([t.registration.mode, t.registration.providers, t.registration.budget.maxRegistrationPrice], ["auto-buy", ["ovh-main"], 25]);
    assert.equal(rows[1]!.domain, "quoted.pl");
  });

  it("reports bad rows, duplicates and existing targets", () => {
    const existing = { ids: new Set(["old-pl"]), domains: new Map([["old.pl", "old-pl"], ["claimed.pl", "someone"]]) };
    const rows = parseImport("bad domain!\nok.pl not-a-date\ndup.pl\ndup.pl\nold.pl\nclaimed.pl\n", defaults, existing, false);
    assert.deepEqual(rows.map((r) => r.action), ["error", "error", "create", "error", "skip", "error"]);
    assert.equal(parseImport("old.pl", defaults, existing, true)[0]!.action, "update");
  });

  it("applies rows through the validated config writer", async () => {
    const dir = tempDir();
    const path = join(dir, "config.yaml");
    writeFileSync(path, "# keep me\ntargets: []\n");
    const file = new ConfigFile(path);
    const rows = parseImport("a-domain.pl 2026-10-05 10:00\nb-domain.com", defaults, none, false);
    await file.save(applyImport(file, rows));
    const text = readFileSync(path, "utf8");
    assert.match(text, /# keep me/);
    assert.match(text, /a-domain\.pl/);
    assert.match(text, /expectedAt: 2026-10-05T08:00:00.000Z/);
    assert.throws(() => applyImport(file, parseImport("x.pl\nx.pl", defaults, none, false)), /errors/);
  });
});

describe("calendar export", () => {
  it("produces valid iCalendar events with reminders and escaping", () => {
    const ics = toIcs([
      { id: "t1", domain: "a.pl", unicode: "zażółć, a;b.pl", expectedAt: Date.UTC(2026, 9, 5, 8), windowStart: Date.UTC(2026, 9, 5, 7, 50), windowEnd: Date.UTC(2026, 9, 5, 8, 15), mode: "auto-buy", enabled: true },
    ], Date.UTC(2026, 8, 1));
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /DTSTART:20261005T075000Z\r\n/);
    assert.match(ics, /DTEND:20261005T081500Z\r\n/);
    assert.match(ics, /SUMMARY:Drop: zażółć\\, a\\;b\.pl\r\n/);
    assert.match(ics, /TRIGGER:-PT15M/);
    for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
  });
});

describe("ntp", () => {
  it("computes offset and round trip from an SNTP reply", async () => {
    const server = createSocket("udp4");
    const skewMs = 1500;
    server.on("message", (msg, rinfo) => {
      const reply = Buffer.alloc(48);
      reply[0] = 0x1c; // mode 4 (server)
      reply[1] = 2; // stratum
      const now = Date.now() + skewMs;
      const secs = Math.floor(now / 1000) + 2_208_988_800;
      const frac = Math.floor(((now % 1000) / 1000) * 2 ** 32);
      for (const at of [32, 40]) {
        reply.writeUInt32BE(secs, at);
        reply.writeUInt32BE(frac, at + 4);
      }
      server.send(reply, rinfo.port, rinfo.address);
      void msg;
    });
    await new Promise<void>((r) => server.bind(0, "127.0.0.1", r));
    try {
      const sample = await queryNtp("127.0.0.1", { port: (server.address() as AddressInfo).port, timeoutMs: 1000 });
      assert.ok(Math.abs(sample.offsetMs - skewMs) < 50, `offset ${sample.offsetMs}`);
      assert.ok(sample.rttMs >= 0 && sample.rttMs < 200);
    } finally {
      server.close();
    }
  });

  it("times out cleanly when nothing answers", async () => {
    const silent = createSocket("udp4");
    await new Promise<void>((r) => silent.bind(0, "127.0.0.1", r));
    try {
      await assert.rejects(queryNtp("127.0.0.1", { port: (silent.address() as AddressInfo).port, timeoutMs: 100 }), /timeout/);
    } finally {
      silent.close();
    }
  });
});
