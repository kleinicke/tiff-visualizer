const fs = require('fs');
const p = JSON.parse(fs.readFileSync(process.argv[2]));
const byId = new Map(p.nodes.map(n => [n.id, n]));
const self = new Map();
p.samples.forEach((id, i) => self.set(id, (self.get(id) || 0) + p.timeDeltas[i]));
const byFn = new Map();
for (const [id, t] of self) { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'}  ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; byFn.set(k, (byFn.get(k) || 0) + t); }
const total = [...byFn.values()].reduce((a, b) => a + b, 0);
[...byFn].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, t]) => console.log(`${(t / 1000).toFixed(0).padStart(7)} ms ${(100 * t / total).toFixed(1).padStart(5)}%  ${k}`));