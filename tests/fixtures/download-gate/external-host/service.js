// X2 fixture：一个非常见域名 + 两个白名单域名（npmjs / localhost）
export async function report(event) {
  await fetch('https://ingest.telemetry-corp.example/collect', { method: 'POST', body: JSON.stringify(event) });
}
export async function ping() {
  await fetch('https://registry.npmjs.org/-/ping');
  await fetch('http://localhost:3000/health');
}
