import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import bcrypt from 'bcryptjs';
import { randomBytes, createHash, randomInt } from 'crypto';

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, p) => pool.query(t, p);
const H = (s) => createHash('sha256').update(s).digest('hex');
const int = (v, d = 0) => (Number.isFinite(+v) ? Math.round(+v) : d);
class E extends Error { constructor(m, c = 400) { super(m); this.c = c; } }

async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}
// Reparto por resto mayor: la suma de las partes es EXACTAMENTE el total.
function alloc(total, w) {
  const sum = w.reduce((a, b) => a + b, 0);
  if (!sum || !total) return w.map(() => 0);
  const raw = w.map((x) => (total * x) / sum), fl = raw.map(Math.floor);
  let r = total - fl.reduce((a, b) => a + b, 0);
  raw.map((x, i) => [i, x - fl[i]]).sort((a, b) => b[1] - a[1]).forEach(([i]) => { if (r > 0) { fl[i]++; r--; } });
  return fl;
}
const aud = (c, u, action, detail) => c.query('insert into audit(user_id,action,detail) values($1,$2,$3)', [u.id, action, detail]);
const mv = (c, lot, type, qty, ref, uid) => c.query('insert into movements(lot_id,type,qty,ref,user_id) values($1,$2,$3,$4,$5)', [lot, type, qty, ref, uid]);

async function sess(req) {
  const m = /jp_sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const r = await q('select u.id,u.username,u.must_change from sessions s join users u on u.id=s.user_id where s.id=$1 and s.expires_at>now()', [H(m[1])]);
  return r.rows[0] || null;
}

async function login(req, res, b) {
  const user = String(b.user || '').trim(), pass = String(b.pass || '');
  const key = ((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x') + '|' + user.toLowerCase();
  const n = (await q("select count(*)::int n from login_attempts where key=$1 and at>now()-interval '10 minutes'", [key])).rows[0].n;
  if (n >= 5) throw new E('Demasiados intentos. Espera unos minutos.', 429);
  let row = (await q('select * from users where lower(username)=lower($1)', [user])).rows[0];
  // Primer ingreso: si no hay usuarios, se crea el administrador con las credenciales iniciales (obliga a cambiarlas).
  if (!row && (await q('select 1 from users limit 1')).rows.length === 0 &&
      user === (process.env.INITIAL_USER || 'Jean') && pass === (process.env.INITIAL_PASSWORD || '080520')) {
    row = (await q('insert into users(username,password_hash,must_change) values($1,$2,true) returning *', [user, await bcrypt.hash(pass, 12)])).rows[0];
  }
  if (!row || !(await bcrypt.compare(pass, row.password_hash))) {
    await q('insert into login_attempts(key) values($1)', [key]);
    throw new E('Credenciales incorrectas.', 401);
  }
  await q('delete from login_attempts where key=$1', [key]);
  const sid = randomBytes(32).toString('hex');
  await q("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '7 days')", [H(sid), row.id]);
  res.setHeader('Set-Cookie', `jp_sid=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`);
  res.json({ ok: true, must: row.must_change });
}

const A = {
  async logout(b, u, req, res) {
    const m = /jp_sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
    if (m) await q('delete from sessions where id=$1', [H(m[1])]);
    res.setHeader('Set-Cookie', 'jp_sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  },
  async load() {
    const [s, p, l, v] = await Promise.all([
      q('select * from suppliers order by name'), q('select * from perfumes order by lower(name), ml'),
      q('select * from lots order by created_at'), q('select * from sales order by at desc limit 1000')]);
    return {
      sup: s.rows.map((x) => ({ id: x.id, name: x.name, country: x.country, contact: x.contact, active: x.active })),
      per: p.rows.map((x) => ({ id: x.id, sku: x.sku, name: x.name, ml: x.ml, brand: x.brand, price: x.price, min: x.min_stock, active: x.active, hist: x.hist })),
      lot: l.rows.map((x) => ({ id: x.id, per: x.perfume_id, sup: x.supplier_id, qty: x.qty, avail: x.avail, buy: x.buy, cus: x.cus, sha: x.sha,
        bcp: x.bcp, oth: x.oth, prov: x.prov, rec: x.rec, ref: x.ref, fx: x.fx == null ? null : +x.fx, date: +new Date(x.created_at) })),
      sale: v.rows.map((x) => ({ id: x.code, code: x.code, at: +new Date(x.at), cust: x.cust, pay: x.pay, items: x.items, total: x.total,
        paid: x.paid, cost: x.cost, profit: x.profit, status: x.status, ship: x.ship, belowCost: x.below })),
    };
  },
  async saveSup({ sup: s }, u) {
    const name = String(s?.name || '').trim(); if (!name) throw new E('Falta el nombre');
    await q('insert into suppliers(name,country,contact) values($1,$2,$3)', [name, s.country || null, s.contact || null]);
    return { ok: true };
  },
  async savePer({ per: p }, u) {
    const name = String(p?.name || '').trim(), sku = String(p?.sku || '').trim();
    if (!name || !sku) throw new E('Falta nombre o código');
    const ml = p.ml ? Math.max(0, int(p.ml)) : null, price = Math.max(0, int(p.price)), min = Math.max(0, int(p.min, 3));
    if (p.id) {
      await q(`update perfumes set name=$2,brand=$3,sku=$4,price=$5,min_stock=$6,active=$7,ml=$8,
        hist=case when price<>$5 then hist||jsonb_build_array(jsonb_build_object('old',price,'new',$5::int,'at',(extract(epoch from now())*1000)::bigint)) else hist end
        where id=$1`, [p.id, name, p.brand || null, sku, price, min, p.active !== false, ml]);
    } else {
      await q('insert into perfumes(name,brand,sku,price,min_stock,ml) values($1,$2,$3,$4,$5,$6)', [name, p.brand || null, sku, price, min, ml]);
    }
    return { ok: true };
  },
  buy: (b, u) => tx(async (c) => {
    const L = (b.lines || []).filter((l) => l.per && int(l.qty) > 0 && +l.usd > 0);
    if (!b.sup || !L.length) throw new E('Datos de compra incompletos');
    const fx = +b.fx > 0 ? +b.fx : null;
    const w = L.map((l) => Math.round(int(l.qty) * l.usd * 100));
    const buy = L.map((l) => Math.round(int(l.qty) * l.usd * (fx || 0) * 100));
    const cus = alloc(int(b.cus), w), bcp = alloc(int(b.bcp), w), oth = alloc(int(b.oth), w);
    const sha = alloc(int(b.sha), b.meth === 'units' ? L.map((l) => int(l.qty)) : w);
    const rec = !!b.rec;
    for (let i = 0; i < L.length; i++) {
      const r = await c.query(`insert into lots(perfume_id,supplier_id,qty,avail,buy,cus,sha,bcp,oth,prov,rec,ref,fx,received_at,created_by)
        values($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
        [L[i].per, b.sup, int(L[i].qty), buy[i], cus[i], sha[i], bcp[i], oth[i], !fx, rec, b.ref || '', fx, rec ? new Date() : null, u.id]);
      if (rec) await mv(c, r.rows[0].id, 'receipt', int(L[i].qty), b.ref || '', u.id);
    }
    await aud(c, u, 'buy', { ref: b.ref, lines: L.length });
    return { ok: true };
  }),
  recv: ({ id }, u) => tx(async (c) => {
    const r = await c.query('update lots set rec=true,received_at=now() where id=$1 and not rec returning qty', [id]);
    if (r.rows[0]) await mv(c, id, 'receipt', r.rows[0].qty, null, u.id);
    return { ok: true };
  }),
  async sell(b, u) {
    if (!b.idem) throw new E('Falta identificador de operación');
    const ex = (await q('select code from sales where idem=$1', [b.idem])).rows[0];
    if (ex) return { code: ex.code, dup: true };          // reintento: no descuenta dos veces
    return tx(async (c) => {
      const ls = (b.items || []).filter((i) => i.lot && int(i.qty) > 0).sort((x, y) => (x.lot < y.lot ? -1 : 1));
      if (!ls.length) throw new E('Venta vacía');
      const items = []; let total = 0, cost = 0, below = false;
      for (const i of ls) {
        const l = (await c.query('select l.*,p.name,p.ml,p.price from lots l join perfumes p on p.id=l.perfume_id where l.id=$1 for update of l', [i.lot])).rows[0];
        if (!l || !l.rec) throw new E('Lote no disponible');
        const qty = int(i.qty); if (l.avail < qty) throw new E(`Stock insuficiente (${l.avail} disponibles)`);
        const price = int(i.price); if (price <= 0) throw new E('Falta el precio');
        const uc = Math.round((l.buy + l.cus + l.sha + l.bcp + l.oth) / l.qty);
        if (price < uc) { if (!b.belowOk) throw new E('Precio menor al costo: requiere confirmación'); below = true; }
        await c.query('update lots set avail=avail-$2 where id=$1', [l.id, qty]);
        items.push({ lot: l.id, per: l.perfume_id, name: l.name + (l.ml ? ` ${l.ml} ml` : ''), qty, price, rec: l.price || 0, cost: uc });
        total += price * qty; cost += uc * qty;
      }
      const paid = b.paid == null || b.paid === '' ? total : Math.max(0, Math.min(int(b.paid), total));
      for (let t = 0; t < 8; t++) {
        const code = String(randomInt(1e7, 1e8));
        const r = await c.query(`insert into sales(code,idem,cust,pay,total,paid,cost,profit,items,below,created_by)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (code) do nothing returning code`,
          [code, b.idem, (b.cust || '').slice(0, 120) || null, String(b.pay || 'Efectivo'), total, paid, cost, total - cost, JSON.stringify(items), below, u.id]);
        if (r.rows.length) {
          for (const it of items) await mv(c, it.lot, 'sale', -it.qty, code, u.id);
          await aud(c, u, 'sale', { code, total, below });
          return { code };
        }
      }
      throw new E('No se pudo generar el código', 500);
    });
  },
  voidSale: ({ code }, u) => tx(async (c) => {
    const s = (await c.query('select * from sales where code=$1 for update', [code])).rows[0];
    if (!s) throw new E('No existe', 404);
    if (s.status === 'void') throw new E('Ya estaba anulada');
    for (const i of s.items) { await c.query('update lots set avail=least(qty,avail+$2) where id=$1', [i.lot, i.qty]); await mv(c, i.lot, 'void', i.qty, code, u.id); }
    await c.query("update sales set status='void',void_at=now() where code=$1", [code]);
    await aud(c, u, 'void', { code });
    return { ok: true };
  }),
  async saveShip({ code, ship: s }) {
    const f = (v) => String(v || '').trim().slice(0, 120);
    if (!f(s?.name) || !/^\d{8}$/.test(f(s?.dni)) || !f(s?.day) || !f(s?.br)) throw new E('Datos de envío incompletos');
    await q('update sales set ship=$2 where code=$1', [code, JSON.stringify({ code: f(s.code), name: f(s.name), dni: f(s.dni), day: f(s.day), br: f(s.br) })]);
    return { ok: true };
  },
  async changeCreds({ user, pass }, u) {
    if (!String(user || '').trim() || String(pass || '').length < 8) throw new E('Usuario requerido y contraseña de 8+ caracteres');
    await q('update users set username=$2,password_hash=$3,must_change=false where id=$1', [u.id, String(user).trim(), await bcrypt.hash(String(pass), 12)]);
    return { ok: true };
  },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST' || req.headers['x-requested-with'] !== 'jp') throw new E('Solicitud no válida');
    const b = req.body || {}, a = b.a;
    if (a === 'login') return await login(req, res, b);
    const u = await sess(req);
    if (a === 'me') return res.json(u ? { ok: true, must: u.must_change } : { ok: false });
    if (!u) throw new E('No autorizado', 401);
    if (!Object.hasOwn(A, a)) throw new E('Acción desconocida');
    res.json(await A[a](b, u, req, res));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Registro duplicado (código o referencia repetida)' });
    if (!e.c) console.error(e);
    res.status(e.c || 500).json({ error: e.c ? e.message : 'Error interno del servidor' });
  }
}
