// 压测：autocannon 封装（主进程已限温和上限 60s / 50 连接）
import autocannon from 'autocannon';

export function stressTarget(url, { duration = 10, connections = 10 } = {}) {
  return new Promise((resolve, reject) => {
    autocannon({ url, duration, connections, pipelining: 1 }, (err, res) => {
      if (err) return reject(err);
      // 自食教训：autocannon 的百分位字段是 p50/p75/p90/p97_5/p99…，没有 p95。
      // 不把 p97_5 假冒成 p95（数值不对就是撒谎），字段名照实叫 p97_5。
      const p975 = res.latency?.p97_5;
      resolve({
        url, duration, connections,
        samples: Number(res.requests?.total) || 0,
        rpsAvg: Math.round(res.requests?.average || 0),
        p97_5LatencyMs: typeof p975 === 'number' ? Math.round(p975 * 10) / 10 : null,
        // 错误数 = 连接/请求错误 + HTTP 4xx/5xx；3xx 不算错误（重定向是正常语义）。
        // 同样自食教训：autocannon 没有 non2xx3xx 字段，原写法等于把 4xx/5xx 全漏掉。
        errors: (res.errors || 0) + (res['4xx'] || 0) + (res['5xx'] || 0),
        statusCodes: res.statusCodeStats || {},
        throughputAvgBytes: Math.round(res.throughput?.average || 0)
      });
    });
  });
}
