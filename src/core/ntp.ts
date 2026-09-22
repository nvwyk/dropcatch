import { createSocket } from "node:dgram";

/** Seconds between 1900-01-01 (NTP epoch) and 1970-01-01 (Unix epoch). */
const NTP_EPOCH_OFFSET = 2_208_988_800;

export interface NtpSample {
  server: string;
  /** Server time minus local time, in ms. Positive = local clock is behind. */
  offsetMs: number;
  /** Network round trip, in ms. */
  rttMs: number;
}

function readTimestamp(buf: Buffer, at: number): number {
  const seconds = buf.readUInt32BE(at);
  const fraction = buf.readUInt32BE(at + 4);
  return (seconds - NTP_EPOCH_OFFSET) * 1000 + (fraction / 2 ** 32) * 1000;
}

/** One SNTP (RFC 4330) query over UDP. */
export function queryNtp(server: string, opts: { port?: number; timeoutMs?: number; now?: () => number } = {}): Promise<NtpSample> {
  const now = opts.now ?? Date.now;
  return new Promise((resolve, reject) => {
    const socket = createSocket(server.includes(":") && !server.includes(".") ? "udp6" : "udp4");
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b; // LI 0, version 3, mode 3 (client)
    let t0 = 0;
    const timer = setTimeout(() => finish(new Error(`NTP ${server}: timeout`)), opts.timeoutMs ?? 1500);
    function finish(err: Error | null, sample?: NtpSample): void {
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(sample!);
    }
    socket.once("error", (err) => finish(err));
    socket.once("message", (msg) => {
      const t3 = now();
      if (msg.length < 48) return finish(new Error(`NTP ${server}: short reply`));
      const mode = msg[0]! & 0x07;
      const stratum = msg[1]!;
      if (mode !== 4 || stratum < 1 || stratum > 15) return finish(new Error(`NTP ${server}: unusable reply (mode ${mode}, stratum ${stratum})`));
      const t1 = readTimestamp(msg, 32); // server receive
      const t2 = readTimestamp(msg, 40); // server transmit
      finish(null, { server, offsetMs: Math.round(((t1 - t0) + (t2 - t3)) / 2), rttMs: Math.max(0, Math.round((t3 - t0) - (t2 - t1))) });
    });
    t0 = now();
    socket.send(packet, opts.port ?? 123, server, (err) => {
      if (err) finish(err);
    });
  });
}

/** Query several servers a few times each and keep the sample with the lowest round trip. */
export async function measureClockOffset(servers: string[], opts: { samplesPerServer?: number; timeoutMs?: number; port?: number } = {}): Promise<NtpSample> {
  const samples: NtpSample[] = [];
  const errors: string[] = [];
  for (const server of servers) {
    for (let i = 0; i < (opts.samplesPerServer ?? 2); i++) {
      try {
        samples.push(await queryNtp(server, { timeoutMs: opts.timeoutMs, port: opts.port }));
      } catch (err) {
        errors.push((err as Error).message);
        break;
      }
    }
    if (samples.length >= 3) break;
  }
  if (!samples.length) throw new Error(errors.join("; ") || "no NTP servers configured");
  return samples.sort((a, b) => a.rttMs - b.rttMs)[0]!;
}
