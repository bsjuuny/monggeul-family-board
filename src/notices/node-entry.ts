// 태블릿 서버(tablet_server/analyzer_bridge.py)가 node 로 실행하는 분석기 진입점.
// stdin: [{text, receivedOn}]  →  stdout: [{digest, contentHash}]
import { buildDigest } from './digest';

declare const process: {
  stdin: { setEncoding(e: string): void; on(ev: string, cb: (chunk?: string) => void): void };
  stdout: { write(s: string): void };
  exitCode: number;
};

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk ?? '';
});
process.stdin.on('end', () => {
  try {
    const items = JSON.parse(input) as Array<{ text: string; receivedOn: string }>;
    const out = items.map((it) => buildDigest(String(it.text ?? ''), String(it.receivedOn ?? '')));
    process.stdout.write(JSON.stringify(out));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.name : 'Error' }));
    process.exitCode = 1;
  }
});
