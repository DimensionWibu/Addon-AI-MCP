const initSqlJs = require('sql.js'); const fs = require('fs'); const os = require('os'); const path = require('path');
(async () => {
  const w = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
  const SQL = await initSqlJs({ wasmBinary: w.buffer.slice(w.byteOffset, w.byteOffset + w.byteLength) });
  const db = new SQL.Database(Uint8Array.from(fs.readFileSync(path.join(os.homedir(), 'AppData', 'Roaming', 'Grove', 'grove.sqlite'))));
  const r = db.exec("SELECT title, role, status, ctx_input FROM sessions ORDER BY role DESC, order_index");
  const rows = (r[0] && r[0].values) || [];
  const running = rows.filter(([t, ro, st]) => st === 'running').length;
  console.log(rows.map(([t, ro, st, c]) => `  [${ro}] ${t} | ${st} | ctx=${c}`).join('\n'));
  process.exit(running >= 1 ? 0 : 1);
})();
