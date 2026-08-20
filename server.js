/**
 * 华南区域19门店营销管理协同平台 - Railway/PostgreSQL 部署版
 * 三级权限: 总部(admin) > 门店经理(manager) > 员工(agent)
 * P1线索 → P2到访 → P3交定 → P4签约
 */
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '5mb' }));
// 所有 API 响应禁止浏览器缓存（防止前端拿到旧数据）
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});
// 静态文件：HTML 每次向服务器校验是否更新（防止同事浏览器一直用旧版页面代码）
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// ==================== DATABASE ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

// Helper: convert ? placeholders to $1, $2, etc. and run query
async function q(sql, params = []) {
  let idx = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
  const result = await pool.query(pgSql, params);
  return result;
}
// Get single row
async function qGet(sql, params = []) {
  const result = await q(sql, params);
  return result.rows[0];
}
// Get all rows
async function qAll(sql, params = []) {
  const result = await q(sql, params);
  return result.rows;
}
// Run and return insert id
async function qInsert(sql, params = []) {
  // sql must end with RETURNING id
  const result = await q(sql, params);
  return result.rows[0]?.id;
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

// 生成随机登录 token，避免不同用户密码相同时 token 冲突
function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ==================== SCHEMA INIT ====================
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stores (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      district TEXT
    );
    CREATE TABLE IF NOT EXISTS agents (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      store_id INTEGER NOT NULL REFERENCES stores(id),
      role TEXT DEFAULT 'agent'
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent',
      agent_id INTEGER REFERENCES agents(id),
      store_id INTEGER REFERENCES stores(id)
    );
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      store_id INTEGER NOT NULL REFERENCES stores(id),
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      add_date TEXT,
      level TEXT DEFAULT 'P1',
      customer_name TEXT,
      demographic TEXT,
      age_range TEXT,
      reception_duration TEXT,
      channel TEXT,
      work_area TEXT,
      unit_type TEXT,
      budget TEXT,
      objection TEXT,
      reception_notes TEXT,
      lease_term TEXT,
      move_in_time TEXT,
      rating TEXT,
      discount_info TEXT,
      followup_notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS follow_ups (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      agent_id INTEGER,
      content TEXT,
      followup_type TEXT DEFAULT 'phone',
      next_action TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS stage_history (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      from_stage TEXT,
      to_stage TEXT,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- 用户审核状态字段：approved(已通过) / pending(待审核) / rejected(已拒绝)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'approved';
    CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
    -- 登录 token 列：每个用户独立的随机 token，避免相同密码导致 token 冲突
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_token ON users(token) WHERE token IS NOT NULL;
  `);
}

// ==================== SEED DATA ====================
async function seed() {
  const { count } = await qGet('SELECT COUNT(*)::int as count FROM users');
  if (count > 0) return;

  // 19 stores
  const stores = [
    [1, '深圳福围店', '深圳', '福永'], [2, '深圳固戍店', '深圳', '西乡'],
    [3, '深圳后瑞店', '深圳', '后瑞'], [4, '深圳桥头店', '深圳', '桥头'],
    [5, '深圳塘尾店', '深圳', '塘尾'], [6, '深圳沙井店', '深圳', '沙井'],
    [7, '深圳马安山店', '深圳', '马安山'], [8, '深圳大浪店', '深圳', '大浪'],
    [9, '深圳民治店', '深圳', '民治'], [10, '深圳清湖店', '深圳', '清湖'],
    [11, '广州番禺店', '广州', '番禺'], [12, '广州南村店', '广州', '南村'],
    [13, '广州市桥店', '广州', '市桥'], [14, '广州大石店', '广州', '大石'],
    [15, '广州汉溪店', '广州', '汉溪'], [16, '广州客村店', '广州', '客村'],
    [17, '广州天河店', '广州', '天河'], [18, '广州岗顶店', '广州', '岗顶'],
    [19, '广州科韵店', '广州', '科韵'],
  ];
  for (const s of stores) {
    await q('INSERT INTO stores (id, name, city, district) VALUES (?,?,?,?)', s);
  }
  // Reset sequence
  await q("SELECT setval('stores_id_seq', 19)");

  // Real agents from 盘客表
  const realAgents = [
    [1, '胡映', 1, 'agent'], [2, '沙学友', 1, 'agent'], [3, '肖睿', 1, 'agent'],
  ];
  const agentNames = ['张伟','李娜','王芳','刘强','陈明','杨静','赵磊','黄丽','周涛','吴燕',
    '郑凯','孙琳','马超','朱琪','胡蓉','郭峰','林晓','何斌','高悦','罗宇',
    '梁鑫','宋佳','谢鹏','唐瑶','韩冰','冯洁','邓勇','曹慧','彭浩','董洁'];
  let agentId = 4;
  let nameIdx = 0;
  for (let sid = 2; sid <= 19; sid++) {
    const cnt = 2 + (sid % 2);
    for (let j = 0; j < cnt; j++) {
      realAgents.push([agentId++, agentNames[nameIdx++ % agentNames.length], sid, 'agent']);
    }
  }
  for (const a of realAgents) {
    await q('INSERT INTO agents (id, name, store_id, role) VALUES (?,?,?,?)', a);
  }
  await q(`SELECT setval('agents_id_seq', ${agentId - 1})`);

  // Users
  await q('INSERT INTO users (username, password_hash, role, agent_id, store_id) VALUES (?,?,?,?,?)',
    ['admin', hashPassword('admin123'), 'admin', null, null]);
  for (let i = 0; i < 19; i++) {
    await q('INSERT INTO users (username, password_hash, role, agent_id, store_id) VALUES (?,?,?,?,?)',
      [`mgr${String(i+1).padStart(2,'0')}`, hashPassword('mgr123'), 'manager', null, i+1]);
  }
  for (let i = 0; i < realAgents.length; i++) {
    await q('INSERT INTO users (username, password_hash, role, agent_id, store_id) VALUES (?,?,?,?,?)',
      [`agent${String(i+1).padStart(2,'0')}`, hashPassword('123456'), 'agent', realAgents[i][0], realAgents[i][2]]);
  }

  // Real 盘客表 data (14 records)
  const realData = [
    { date: '2026-04-01', level: 'P2', agent: '胡映', name: '4.1贝壳 高', demo: '单男', age: '21-30岁', dur: '60分钟内', ch: '贝壳', area: '南山', unit: '阳光loft', budget: '2000', obj: '房型价格', notes: '男生，预算2千内，短租2个月，对采光要求比较高完全不考虑内窗，带看1-376觉得价格高，要考虑', term: '2', move: '最近', rating: 'D:已流失', disc: '', fu: '已签约别的地方' },
    { date: '2026-04-01', level: 'P2', agent: '胡映', name: '4.1贝壳 昴', demo: '单女', age: '21-30岁', dur: '60分钟内', ch: '贝壳', area: '南山', unit: '阳光loft', budget: '2500内', obj: '房型价格', notes: '想要采光好的房间，押一付一，短租3个月，已约周五下午看房', term: '3', move: '最近', rating: 'D:已流失', disc: '', fu: '回访说还要再考虑看看，清明节之后才能确定 后面说租了' },
    { date: '2026-04-01', level: 'P1', agent: '胡映', name: '4.1贝壳 Fiona', demo: '单女', age: '21-30岁', dur: '', ch: '贝壳', area: '南山', unit: '阳光loft', budget: '1600', obj: '房型价格', notes: '要最便宜的户型，发送了视频，觉得内窗采光不太好，还在跟进', term: '12', move: '没说', rating: '低需求', disc: '', fu: '回访一直不回消息' },
    { date: '2026-04-01', level: 'P1', agent: '胡映', name: '4.1小红书 谷', demo: '单女', age: '21-30岁', dur: '', ch: '小红书', area: '未知', unit: '阳光loft', budget: '', obj: '房型价格', notes: '两个人住，小红书看的8楼内窗上下两层的大复式，想要这种户型，目前没有空房', term: '12', move: '没说', rating: 'C:抗性大转化难', disc: '', fu: '' },
    { date: '2026-04-01', level: 'P2', agent: '胡映', name: '4.1三网 微笑', demo: '单男', age: '21-30岁', dur: '60分钟内', ch: '三网', area: '西乡', unit: '阳光loft', budget: '2000', obj: '房型价格', notes: '男生看房，西乡上班现在住在福永，预算2千左右，对采光要求比较高完全不考虑内窗', term: '6', move: '最近', rating: 'D:已流失', disc: '', fu: '回访说不考虑了' },
    { date: '2026-04-01', level: 'P1', agent: '沙学友', name: '恩恩女士', demo: '单女', age: '21-30岁', dur: '', ch: '贝壳', area: '附近', unit: '阳光loft', budget: '2000', obj: '房型价格', notes: '客户预算2000内，短租需求，需要离地铁口近些，正在邀约看房中', term: '1-2个月', move: '一周内', rating: 'D:已流失', disc: '', fu: '晚间回访通勤具体原因已放弃' },
    { date: '2026-04-01', level: 'P2', agent: '沙学友', name: '黄老师', demo: '单男', age: '31-40岁', dur: '30分钟内', ch: '三网', area: '罗湖', unit: '暗房性价比loft', budget: '2000内', obj: '房型价格', notes: '客户在罗湖就业，意向暗房性价比户型，罗湖的房子将于近日到期', term: '6', move: '近期', rating: 'D:已流失', disc: '', fu: '回访客户询问工资不按时发放，逾期的处理方式，如实解答后，已放弃' },
    { date: '2026-04-01', level: 'P1', agent: '肖睿', name: '强壮的一土林', demo: '单女', age: '21-30岁', dur: '', ch: '贝壳', area: '前海', unit: '阳光loft', budget: '2500', obj: '房间', notes: '租期6个月，预算2500全包，发了外窗视频，想要精装修的，邀约来看房', term: '6', move: '近期', rating: 'D:已流失', disc: '', fu: '4.12已不回消息' },
    { date: '2026-04-01', level: 'P1', agent: '肖睿', name: 'Leo', demo: '单男', age: '21-30岁', dur: '', ch: '贝壳', area: '南山', unit: '暗房性价比loft', budget: '1000', obj: '价格 房型', notes: '低预算客户，发了内窗视频觉得装修差，发了外窗视频还是觉得装修差', term: '3', move: '近期', rating: 'D:已流失', disc: '', fu: '' },
    { date: '2026-04-01', level: 'P4', agent: '肖睿', name: '不羁', demo: '单男', age: '21-30岁', dur: '', ch: '贝壳', area: '暂无工作', unit: '暗房性价比loft', budget: '1600左右', obj: '价格', notes: '目前邀约到周六来看房。', term: '1', move: '', rating: '已签约', disc: '', fu: '' },
    { date: '2026-04-01', level: 'P1', agent: '肖睿', name: 'Redamancy', demo: '单男', age: '21-30岁', dur: '', ch: '贝壳', area: '暂无工作', unit: '暗房性价比loft', budget: '1700左右', obj: '价格', notes: '已发内外窗视频，邀约到晚上来看房，晚上回访大概什么时候到，未回复。', term: '12', move: '这一个星期', rating: 'D:已流失', disc: '', fu: '' },
    { date: '2026-04-01', level: 'P1', agent: '肖睿', name: '欣欣', demo: '单男', age: '21-30岁', dur: '', ch: '贝壳', area: '福田', unit: '暗房性价比loft', budget: '1600', obj: '价格 房型', notes: '已发内外窗视频，未回复。', term: '12', move: '', rating: 'D:已流失', disc: '', fu: '4.12已不回消息' },
    { date: '2026-04-01', level: 'P4', agent: '肖睿', name: 'jesson-', demo: '单男', age: '21-30岁', dur: '20分钟内', ch: '贝壳', area: '暂无工作', unit: '暗房性价比loft', budget: '1600', obj: '价格 房型', notes: '预算1600左右，带看内窗房间，比较满意1-431，但是租客目前没找到工作，要去龙华那边看看', term: '1', move: '', rating: '已签约', disc: '', fu: '' },
    { date: '2026-04-02', level: 'P1', agent: '胡映', name: '4.2 喜羊羊', demo: '单男', age: '21-30岁', dur: '', ch: '三网', area: '未定', unit: '阳光loft', budget: '2000内', obj: '价格 房型', notes: '给公司看房，公司有意向要在这边开一个新点位，需要给员工安排住宿，预算2千内，总共需要可能20间左右', term: '12', move: '两周内', rating: 'C:抗性大转化难', disc: '', fu: '' },
  ];
  const agentMap = {};
  realAgents.forEach(a => { agentMap[a[1]] = { id: a[0], store_id: a[2] }; });

  for (const d of realData) {
    const ag = agentMap[d.agent];
    if (!ag) continue;
    const custId = await qInsert(`INSERT INTO customers
      (store_id, agent_id, add_date, level, customer_name, demographic, age_range, reception_duration,
       channel, work_area, unit_type, budget, objection, reception_notes, lease_term, move_in_time,
       rating, discount_info, followup_notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [ag.store_id, ag.id, d.date, d.level, d.name, d.demo, d.age, d.dur,
       d.ch, d.area, d.unit, d.budget, d.obj, d.notes, d.term, d.move, d.rating, d.disc, d.fu]);
    if (d.fu) {
      await q('INSERT INTO follow_ups (customer_id, agent_id, content, followup_type) VALUES (?,?,?,?) RETURNING id',
        [custId, ag.id, d.fu, 'phone']);
    }
    await q('INSERT INTO stage_history (customer_id, from_stage, to_stage, note) VALUES (?,?,?,?)',
      [custId, null, d.level, '初始录入']);
  }

  // Generate sample data for other 18 stores
  const channels = ['贝壳', '三网', '小红书', '抖音', '户外广告', '转介绍', '门店自然来访'];
  const unitTypes = ['阳光loft', '暗房性价比loft', '复式loft', '一房一厅', '单间'];
  const objections = ['价格', '房型价格', '房间', '价格 房型', '位置', '采光', '预算不足', '已租其他'];
  const demographics = ['单男', '单女', '夫妻', '朋友'];
  const ages = ['21-30岁', '31-40岁', '41-50岁'];
  const durations = ['20分钟内', '30分钟内', '60分钟内'];
  const moveTimes = ['最近', '近期', '一周内', '两周内', '没说', '一个月内'];
  const ratingsByLevel = {
    P1: ['A:有意向', 'B:待跟进', 'C:抗性大转化难', 'D:已流失', '低需求'],
    P2: ['A:有意向', 'B:待跟进', 'C:抗性大转化难', 'D:已流失'],
    P3: ['A:有意向', 'B:待跟进'],
    P4: ['已签约'],
  };
  const areas = ['南山', '福田', '罗湖', '宝安', '龙华', '前海', '西乡', '附近', '暂无工作', '未定'];
  const sampleNotes = [
    '客户预算有限，在对比周边房源，持续跟进中',
    '已发房源视频，客户表示满意，约周末看房',
    '客户工作调动，需要通勤方便的户型',
    '价格超出预算，尝试推荐性价比户型',
    '客户对采光要求高，推荐外窗房源',
    '已到店看房，对户型满意但需要考虑租期',
    '客户短租需求，推荐灵活租期方案',
    '已缴定金，等待签约',
    '客户对比竞品后选择我们，已签约',
    '跟进多次未回复，标记为流失',
    '客户朋友推荐，意向较高',
    '需要公司审批，等待回复中',
  ];
  const allAgents = await qAll('SELECT id, name, store_id FROM agents WHERE store_id > 1');
  const today = new Date('2026-04-30');
  let sampleCount = 0;

  for (const ag of allAgents) {
    const custCount = 15 + Math.floor(Math.random() * 25);
    for (let i = 0; i < custCount; i++) {
      const r = Math.random();
      let level;
      if (r < 0.45) level = 'P1';
      else if (r < 0.70) level = 'P2';
      else if (r < 0.82) level = 'P3';
      else level = 'P4';

      const dayOffset = Math.floor(Math.random() * 30);
      const dt = new Date(today);
      dt.setDate(dt.getDate() - dayOffset);
      const dateStr = dt.toISOString().slice(0, 10);
      const ratingPool = ratingsByLevel[level];
      const rating = ratingPool[Math.floor(Math.random() * ratingPool.length)];
      const budget = 1000 + Math.floor(Math.random() * 20) * 100;
      const custName = `客户${ag.store_id}-${i + 1}`;
      const ch = channels[Math.floor(Math.random() * channels.length)];
      const note = sampleNotes[Math.floor(Math.random() * sampleNotes.length)];

      const custId = await qInsert(`INSERT INTO customers
        (store_id, agent_id, add_date, level, customer_name, demographic, age_range, reception_duration,
         channel, work_area, unit_type, budget, objection, reception_notes, lease_term, move_in_time,
         rating, discount_info, followup_notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [ag.store_id, ag.id, dateStr, level, custName,
         demographics[Math.floor(Math.random() * demographics.length)],
         ages[Math.floor(Math.random() * ages.length)],
         ['P2','P3','P4'].includes(level) ? durations[Math.floor(Math.random() * durations.length)] : null,
         ch, areas[Math.floor(Math.random() * areas.length)],
         unitTypes[Math.floor(Math.random() * unitTypes.length)],
         String(budget), objections[Math.floor(Math.random() * objections.length)],
         note, [1,2,3,6,12][Math.floor(Math.random()*5)],
         moveTimes[Math.floor(Math.random() * moveTimes.length)],
         rating, null, null]);
      sampleCount++;

      if (level !== 'P1' && Math.random() < 0.6) {
        await q('INSERT INTO follow_ups (customer_id, agent_id, content, followup_type) VALUES (?,?,?,?)',
          [custId, ag.id, note, ['phone','wechat','visit'][Math.floor(Math.random()*3)]]);
      }
    }
  }
  console.log(`[Seed] 19 stores, ${realAgents.length} agents, ${realData.length} real + ${sampleCount} sample customers`);
}

// ==================== AUTH MIDDLEWARE ====================
async function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: '未登录' });
    // 按 token 反查用户（token 是登录时生成的随机值，不会冲突）
    // 兼容老版本：如果用户还没有 token（旧账号），仍允许按 password_hash 查
    const user = await qGet(`
      SELECT u.*, a.name as agent_name, s.name as store_name
      FROM users u
      LEFT JOIN agents a ON u.agent_id = a.id
      LEFT JOIN stores s ON u.store_id = s.id
      WHERE (u.token = ? OR u.password_hash = ?) AND u.status = 'approved'
      ORDER BY (u.token IS NOT NULL) DESC, u.id ASC
      LIMIT 1
    `, [token, token]);
    if (!user) return res.status(401).json({ error: 'Token无效或账号未审核' });
    // 老用户首次用旧 token 登录，立刻补上独立 token，避免下次冲突
    if (!user.token) {
      const newToken = genToken();
      await q('UPDATE users SET token = ? WHERE id = ?', [newToken, user.id]);
      user.token = newToken;
    }
    req.user = user;
    next();
  } catch (e) {
    console.error('Auth error:', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
}

function scopeWhere(req, prefix) {
  const p = prefix ? prefix + '.' : '';
  if (req.user.role === 'admin') return '1=1';
  if (req.user.role === 'manager') return `${p}store_id = ${req.user.store_id}`;
  return `${p}agent_id = ${req.user.agent_id}`;
}

// ==================== API: AUTH ====================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const hash = hashPassword(password);
    const user = await qGet(`
      SELECT u.*, a.name as agent_name, s.name as store_name, s.city as store_city
      FROM users u
      LEFT JOIN agents a ON u.agent_id = a.id
      LEFT JOIN stores s ON u.store_id = s.id
      WHERE u.username = ? AND u.password_hash = ?
    `, [username, hash]);
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });
    // 审核状态检查
    if (user.status === 'pending') return res.status(403).json({ error: '账号待管理员审核，请稍后再试或联系管理员' });
    if (user.status === 'rejected') return res.status(403).json({ error: '账号已被拒绝，请联系管理员' });
    if (user.status === 'disabled') return res.status(403).json({ error: '账号已被禁用，请联系管理员' });
    // 生成独立的随机 token（不再用 password_hash 当 token，避免相同密码冲突）
    const token = genToken();
    await q('UPDATE users SET token = ? WHERE id = ?', [token, user.id]);
    res.json({
      token,
      role: user.role,
      username: user.username,
      agentName: user.agent_name,
      storeName: user.store_name,
      storeId: user.store_id,
      storeCity: user.store_city,
    });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

// NEW: User Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, role, store_name, agent_name } = req.body;
    if (!username || !password) return res.status(400).json({ error: '请填写用户名和密码' });
    if (username.length < 2) return res.status(400).json({ error: '用户名至少2个字符' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

    // Check username uniqueness
    const existing = await qGet('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return res.status(409).json({ error: '用户名已被注册' });

    // Validate role
    const validRole = ['agent', 'manager'].includes(role) ? role : 'agent';

    let storeId = null;
    let agentId = null;

    if (store_name) {
      // Lookup or create store
      let store = await qGet('SELECT id FROM stores WHERE name = ?', [store_name]);
      if (!store) {
        const city = store_name.startsWith('深圳') ? '深圳' : store_name.startsWith('广州') ? '广州' : '其他';
        agentId = await qInsert('INSERT INTO stores (name, city) VALUES (?,?) RETURNING id', [store_name, city]);
        storeId = agentId;
        agentId = null;
      } else {
        storeId = store.id;
      }
    }

    if (agent_name && storeId) {
      let ag = await qGet('SELECT id FROM agents WHERE name = ? AND store_id = ?', [agent_name, storeId]);
      if (!ag) {
        ag = { id: await qInsert('INSERT INTO agents (name, store_id, role) VALUES (?,?,?) RETURNING id', [agent_name, storeId, 'agent']) };
      }
      agentId = ag.id;
    }

    const hash = hashPassword(password);
    await q('INSERT INTO users (username, password_hash, role, agent_id, store_id, status) VALUES (?,?,?,?,?,?)',
      [username, hash, validRole, agentId, storeId, 'pending']);

    res.json({ message: '注册成功，请等待管理员审核后即可登录' });
  } catch (e) {
    console.error('Register error:', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

app.get('/api/auth/verify', auth, (req, res) => {
  res.json({
    role: req.user.role,
    username: req.user.username,
    agentId: req.user.agent_id,
    agentName: req.user.agent_name,
    storeName: req.user.store_name,
    storeId: req.user.store_id,
  });
});

// 修改密码 (所有已登录用户)
app.post('/api/auth/change-password', auth, async (req, res) => {
  try {
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password) return res.status(400).json({ error: '请填写旧密码和新密码' });
    if (new_password.length < 6) return res.status(400).json({ error: '新密码至少6位' });

    const oldHash = hashPassword(old_password);
    if (oldHash !== req.user.password_hash) return res.status(401).json({ error: '旧密码错误' });

    const newHash = hashPassword(new_password);
    const newToken = genToken();
    await q('UPDATE users SET password_hash = ?, token = ? WHERE id = ?', [newHash, newToken, req.user.id]);
    res.json({ token: newToken, message: '密码修改成功' });
  } catch (e) {
    console.error('Change password error:', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== API: ADMIN - USER APPROVAL ====================
// 获取待审核用户列表 (仅 admin)
app.get('/api/admin/pending-users', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可访问' });
    const users = await qAll(`
      SELECT u.id, u.username, u.role, u.status, u.store_id, u.agent_id,
             a.name as agent_name, s.name as store_name, s.city as store_city,
             to_char(u.id, '999999999999') as created_hint
      FROM users u
      LEFT JOIN agents a ON u.agent_id = a.id
      LEFT JOIN stores s ON u.store_id = s.id
      WHERE u.status IN ('pending', 'rejected')
      ORDER BY u.id DESC
    `);
    res.json({ users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 获取所有用户列表 (仅 admin，用于查看审核状态)
app.get('/api/admin/users', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可访问' });
    const users = await qAll(`
      SELECT u.id, u.username, u.role, u.status,
             a.name as agent_name, s.name as store_name, s.city as store_city
      FROM users u
      LEFT JOIN agents a ON u.agent_id = a.id
      LEFT JOIN stores s ON u.store_id = s.id
      ORDER BY u.id DESC
    `);
    res.json({ users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 审核通过 (仅 admin)
app.post('/api/admin/approve-user', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可访问' });
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: '缺少 user_id' });
    const result = await q('UPDATE users SET status = ? WHERE id = ? AND status != ?', ['approved', user_id, 'approved']);
    if (result.rowCount === 0) return res.status(404).json({ error: '用户不存在或已是审核状态' });
    res.json({ message: '已审核通过' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 审核拒绝 (仅 admin)
app.post('/api/admin/reject-user', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可访问' });
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: '缺少 user_id' });
    const result = await q('UPDATE users SET status = ? WHERE id = ?', ['rejected', user_id]);
    if (result.rowCount === 0) return res.status(404).json({ error: '用户不存在' });
    res.json({ message: '已拒绝' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 禁用用户 (仅 admin)
app.post('/api/admin/disable-user', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可访问' });
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: '缺少 user_id' });
    const result = await q('UPDATE users SET status = ? WHERE id = ? AND role != ?', ['disabled', user_id, 'admin']);
    if (result.rowCount === 0) return res.status(404).json({ error: '用户不存在或不能禁用管理员' });
    res.json({ message: '已禁用' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== API: EXPORT (仅 admin) ====================
// 导出所有客户数据为 CSV
app.get('/api/export/customers', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可导出数据' });

    const customers = await qAll(`
      SELECT c.id, c.add_date, c.level, c.customer_name, c.demographic, c.age_range,
             c.reception_duration, c.channel, c.work_area, c.unit_type, c.budget,
             c.objection, c.lease_term, c.move_in_time, c.rating, c.discount_info,
             c.followup_notes, c.reception_notes,
             a.name as agent_name, s.name as store_name, s.city as store_city,
             (SELECT COUNT(*)::int FROM follow_ups f WHERE f.customer_id = c.id) as followup_count,
             to_char(c.created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at,
             to_char(c.updated_at, 'YYYY-MM-DD HH24:MI:SS') as updated_at
      FROM customers c
      JOIN agents a ON c.agent_id = a.id
      JOIN stores s ON c.store_id = s.id
      ORDER BY c.add_date DESC NULLS LAST, c.id DESC
    `);

    // CSV 表头
    const headers = ['ID', '添加日期', '阶段', '客户名称', '运营官', '门店', '城市',
                     '人口结构', '年龄段', '接待时长', '渠道', '工作区域', '意向户型',
                     '预算', '抗性', '租期', '入住时间', '评级', '优惠释放',
                     '跟进次数', '接待情况', '跟进记录', '创建时间', '更新时间'];
    const fields = ['id', 'add_date', 'level', 'customer_name', 'agent_name', 'store_name', 'store_city',
                    'demographic', 'age_range', 'reception_duration', 'channel', 'work_area', 'unit_type',
                    'budget', 'objection', 'lease_term', 'move_in_time', 'rating', 'discount_info',
                    'followup_count', 'reception_notes', 'followup_notes', 'created_at', 'updated_at'];

    // CSV 转义函数（含逗号、引号、换行的字段需要用双引号包裹，内部双引号转义为两个双引号）
    function csvEscape(v) {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }

    // 添加 BOM 让 Excel 正确识别 UTF-8
    let csv = '\ufeff' + headers.map(csvEscape).join(',') + '\r\n';
    for (const row of customers) {
      csv += fields.map(f => csvEscape(row[f])).join(',') + '\r\n';
    }

    const filename = `customers_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) {
    console.error('Export error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 导出跟进记录为 CSV (仅 admin)
app.get('/api/export/followups', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可导出数据' });

    const followups = await qAll(`
      SELECT f.id, f.customer_id, c.customer_name, a.name as agent_name, s.name as store_name,
             f.content, f.followup_type, f.next_action,
             to_char(f.created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at
      FROM follow_ups f
      JOIN customers c ON f.customer_id = c.id
      LEFT JOIN agents a ON f.agent_id = a.id
      LEFT JOIN stores s ON a.store_id = s.id
      ORDER BY f.created_at DESC
    `);

    const headers = ['ID', '客户ID', '客户名称', '运营官', '门店', '跟进内容', '跟进方式', '下一步动作', '跟进时间'];
    const fields = ['id', 'customer_id', 'customer_name', 'agent_name', 'store_name', 'content', 'followup_type', 'next_action', 'created_at'];

    function csvEscape(v) {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }

    let csv = '\ufeff' + headers.map(csvEscape).join(',') + '\r\n';
    for (const row of followups) {
      csv += fields.map(f => csvEscape(row[f])).join(',') + '\r\n';
    }

    const filename = `followups_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) {
    console.error('Export followups error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 导出门店汇总为 CSV (仅 admin)
app.get('/api/export/store-summary', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可导出数据' });

    const stores = await qAll(`
      SELECT s.id, s.name, s.city, s.district,
        COUNT(c.id)::int as total,
        COALESCE(SUM(CASE WHEN c.level = 'P1' THEN 1 ELSE 0 END), 0)::int as p1,
        COALESCE(SUM(CASE WHEN c.level = 'P2' THEN 1 ELSE 0 END), 0)::int as p2,
        COALESCE(SUM(CASE WHEN c.level = 'P3' THEN 1 ELSE 0 END), 0)::int as p3,
        COALESCE(SUM(CASE WHEN c.level = 'P4' THEN 1 ELSE 0 END), 0)::int as p4,
        COUNT(DISTINCT a.id)::int as agent_count
      FROM stores s
      LEFT JOIN customers c ON c.store_id = s.id
      LEFT JOIN agents a ON a.store_id = s.id
      GROUP BY s.id, s.name, s.city, s.district
      ORDER BY s.city, s.id
    `);

    const result = stores.map(s => {
      const total = s.total || 0;
      const visited = (s.p2 || 0) + (s.p3 || 0) + (s.p4 || 0);
      const deposited = (s.p3 || 0) + (s.p4 || 0);
      return {
        ...s,
        rate_p1_p2: total > 0 ? +((visited / total) * 100).toFixed(1) : 0,
        rate_p2_p3: visited > 0 ? +((deposited / visited) * 100).toFixed(1) : 0,
        rate_overall: total > 0 ? +(((s.p4 || 0) / total) * 100).toFixed(1) : 0,
      };
    });

    const headers = ['门店ID', '门店名称', '城市', '区域', '运营官数', '客户总数', 'P1线索', 'P2到访', 'P3交定', 'P4签约', '到访率%', '交定率%', '签约率%'];
    const fields = ['id', 'name', 'city', 'district', 'agent_count', 'total', 'p1', 'p2', 'p3', 'p4', 'rate_p1_p2', 'rate_p2_p3', 'rate_overall'];

    function csvEscape(v) {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }

    let csv = '\ufeff' + headers.map(csvEscape).join(',') + '\r\n';
    for (const row of result) {
      csv += fields.map(f => csvEscape(row[f])).join(',') + '\r\n';
    }

    const filename = `store_summary_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) {
    console.error('Export store summary error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== API: STORES & AGENTS ====================
app.get('/api/stores', async (req, res) => {
  try {
    const stores = await qAll('SELECT * FROM stores ORDER BY city, id');
    res.json({ stores });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agents', async (req, res) => {
  try {
    const { store_id } = req.query;
    let sql = 'SELECT a.*, s.name as store_name, s.city FROM agents a JOIN stores s ON a.store_id = s.id';
    const params = [];
    if (store_id) { sql += ' WHERE a.store_id = ?'; params.push(store_id); }
    sql += ' ORDER BY a.store_id, a.name';
    const agents = await qAll(sql, params);
    res.json({ agents });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== API: CUSTOMERS ====================
app.get('/api/customers', auth, async (req, res) => {
  try {
    const { store_id, agent_id, level, rating, channel, page, limit, search } = req.query;
    let where = scopeWhere(req, 'c');
    const params = [];
    if (store_id && req.user.role === 'admin') { where += ' AND c.store_id = ?'; params.push(store_id); }
    if (agent_id && (req.user.role === 'admin' || req.user.role === 'manager')) { where += ' AND c.agent_id = ?'; params.push(agent_id); }
    if (level) { where += ' AND c.level = ?'; params.push(level); }
    if (rating) { where += ' AND c.rating = ?'; params.push(rating); }
    if (channel) { where += ' AND c.channel = ?'; params.push(channel); }
    if (search) { where += ' AND (c.customer_name LIKE ? OR c.reception_notes LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 50;
    const offset = (pageNum - 1) * limitNum;

    const totalRow = await qGet(`SELECT COUNT(*)::int as c FROM customers c WHERE ${where}`, params);
    const total = totalRow.c;
    const customers = await qAll(`
      SELECT c.*, a.name as agent_name, s.name as store_name, s.city as store_city,
        (SELECT COUNT(*)::int FROM follow_ups f WHERE f.customer_id = c.id) as followup_count,
        (SELECT content FROM follow_ups f WHERE f.customer_id = c.id ORDER BY f.created_at DESC LIMIT 1) as last_followup,
        (SELECT to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') FROM follow_ups f WHERE f.customer_id = c.id ORDER BY f.created_at DESC LIMIT 1) as last_followup_date
      FROM customers c
      JOIN agents a ON c.agent_id = a.id
      JOIN stores s ON c.store_id = s.id
      WHERE ${where}
      ORDER BY c.add_date DESC NULLS LAST, c.id DESC
      LIMIT ? OFFSET ?
    `, [...params, limitNum, offset]);

    res.json({ customers, total, page: pageNum, limit: limitNum });
  } catch (e) {
    console.error('GET customers error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/customers', auth, async (req, res) => {
  try {
    const b = req.body;
    let storeId = b.store_id;
    let agentId = b.agent_id;
    if (req.user.role === 'agent') {
      storeId = req.user.store_id;
      // 运营官自己录入客户时，强制锁定为自己账号的 agent_id，
      // 不再用前端填的 agent_name 重新解析——避免"运营官自己录入但看板看不到自己的客户"
      if (req.user.agent_id) {
        agentId = req.user.agent_id;
        b.agent_name = null;
      }
    } else if (req.user.role === 'manager') {
      storeId = req.user.store_id;
      if (!agentId && !b.agent_name) agentId = req.user.agent_id;
    }
    if (agentId && !storeId) {
      const ag = await qGet('SELECT store_id FROM agents WHERE id = ?', [agentId]);
      if (ag) storeId = ag.store_id;
    }
    if (b.store_name && !storeId) {
      let store = await qGet('SELECT id FROM stores WHERE name = ?', [b.store_name]);
      if (!store) {
        const city = b.store_name.startsWith('深圳') ? '深圳' : b.store_name.startsWith('广州') ? '广州' : '其他';
        storeId = await qInsert('INSERT INTO stores (name, city) VALUES (?,?) RETURNING id', [b.store_name, city]);
      } else {
        storeId = store.id;
      }
    }
    if (!storeId) return res.status(400).json({ error: '缺少门店信息' });
    if (!agentId && b.agent_name) {
      // 优先按 store_id + name 精确匹配
      let ag = await qGet('SELECT id, store_id FROM agents WHERE store_id = ? AND name = ?', [storeId, b.agent_name]);
      if (!ag) {
        // 兜底按 name 全局查
        ag = await qGet('SELECT id, store_id FROM agents WHERE name = ? LIMIT 1', [b.agent_name]);
      }
      if (ag) {
        agentId = ag.id;
        if (!storeId) storeId = ag.store_id;
      } else if (storeId) {
        agentId = await qInsert('INSERT INTO agents (name, store_id, role) VALUES (?,?,?) RETURNING id', [b.agent_name, storeId, 'agent']);
      }
    }
    if (!agentId) {
      let ag = await qGet('SELECT id FROM agents WHERE store_id = ? AND name = ?', [storeId, '待分配']);
      if (!ag) {
        agentId = await qInsert('INSERT INTO agents (name, store_id, role) VALUES (?,?,?) RETURNING id', ['待分配', storeId, 'agent']);
      } else {
        agentId = ag.id;
      }
    }

    const custId = await qInsert(`INSERT INTO customers
      (store_id, agent_id, add_date, level, customer_name, demographic, age_range, reception_duration,
       channel, work_area, unit_type, budget, objection, reception_notes, lease_term, move_in_time,
       rating, discount_info, followup_notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [storeId, agentId, b.add_date || new Date().toISOString().slice(0, 10),
       b.level || 'P1', b.customer_name, b.demographic, b.age_range, b.reception_duration,
       b.channel, b.work_area, b.unit_type, b.budget, b.objection, b.reception_notes,
       b.lease_term, b.move_in_time, b.rating, b.discount_info, b.followup_notes]);

    if (b.reception_notes) {
      await q('INSERT INTO follow_ups (customer_id, agent_id, content, followup_type) VALUES (?,?,?,?)',
        [custId, agentId, b.reception_notes, 'visit']);
    }
    await q('INSERT INTO stage_history (customer_id, from_stage, to_stage, note) VALUES (?,?,?,?)',
      [custId, null, b.level || 'P1', '初始录入']);

    res.json({ id: custId, message: '客户创建成功' });
  } catch (e) {
    console.error('POST customer error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/customers/:id', auth, async (req, res) => {
  try {
    const cid = req.params.id;
    const b = req.body;
    const cust = await qGet('SELECT store_id, agent_id, level FROM customers WHERE id = ?', [cid]);
    if (!cust) return res.status(404).json({ error: '客户不存在' });
    if (req.user.role === 'agent' && cust.agent_id !== req.user.agent_id)
      return res.status(403).json({ error: '无权操作' });
    if (req.user.role === 'manager' && cust.store_id !== req.user.store_id)
      return res.status(403).json({ error: '无权操作' });

    const fields = ['level', 'customer_name', 'demographic', 'age_range', 'reception_duration',
      'channel', 'work_area', 'unit_type', 'budget', 'objection', 'reception_notes',
      'lease_term', 'move_in_time', 'rating', 'discount_info', 'followup_notes'];
    const updates = [];
    const params = [];
    fields.forEach(f => {
      if (b[f] !== undefined) { updates.push(`${f} = ?`); params.push(b[f]); }
    });

    let newStoreId = cust.store_id;
    if (b.store_name && req.user.role === 'admin') {
      let store = await qGet('SELECT id FROM stores WHERE name = ?', [b.store_name]);
      if (!store) {
        const city = b.store_name.startsWith('深圳') ? '深圳' : b.store_name.startsWith('广州') ? '广州' : '其他';
        newStoreId = await qInsert('INSERT INTO stores (name, city) VALUES (?,?) RETURNING id', [b.store_name, city]);
      } else {
        newStoreId = store.id;
      }
      updates.push('store_id = ?'); params.push(newStoreId);
    }
    if (b.agent_name) {
      // 所有角色均可修改运营官；优先按 store_id + name 精确匹配，兜底全局 name，最后新建
      let ag = await qGet('SELECT id FROM agents WHERE store_id = ? AND name = ?', [newStoreId, b.agent_name]);
      if (!ag) {
        ag = await qGet('SELECT id FROM agents WHERE name = ? LIMIT 1', [b.agent_name]);
      }
      if (!ag) {
        ag = { id: await qInsert('INSERT INTO agents (name, store_id, role) VALUES (?,?,?) RETURNING id', [b.agent_name, newStoreId, 'agent']) };
      }
      updates.push('agent_id = ?'); params.push(ag.id);
      console.log(`[PUT customer ${cid}] agent_name="${b.agent_name}" -> agent_id=${ag.id}`);
    }
    updates.push(`updated_at = NOW()`);

    if (b.level && b.level !== cust.level) {
      await q('INSERT INTO stage_history (customer_id, from_stage, to_stage, note) VALUES (?,?,?,?)',
        [cid, cust.level, b.level, b.stage_note || '阶段变更']);
      if (b.level === 'P4') {
        updates.push('rating = ?'); params.push('已签约');
      }
    }

    params.push(cid);
    await q(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ message: '更新成功' });
  } catch (e) {
    console.error('PUT customer error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/customers/:id', auth, async (req, res) => {
  try {
    if (req.user.role === 'agent') return res.status(403).json({ error: '无权删除' });
    const cid = req.params.id;
    await q('DELETE FROM follow_ups WHERE customer_id = ?', [cid]);
    await q('DELETE FROM stage_history WHERE customer_id = ?', [cid]);
    await q('DELETE FROM customers WHERE id = ?', [cid]);
    res.json({ message: '删除成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/customers/:id/stage', auth, async (req, res) => {
  try {
    const cid = req.params.id;
    const { stage, note } = req.body;
    const cust = await qGet('SELECT level, store_id, agent_id FROM customers WHERE id = ?', [cid]);
    if (!cust) return res.status(404).json({ error: '客户不存在' });
    if (req.user.role === 'agent' && cust.agent_id !== req.user.agent_id)
      return res.status(403).json({ error: '无权操作' });

    await q('INSERT INTO stage_history (customer_id, from_stage, to_stage, note) VALUES (?,?,?,?)',
      [cid, cust.level, stage, note || '阶段推进']);
    if (stage === 'P4') {
      await q('UPDATE customers SET level = ?, rating = ?, updated_at = NOW() WHERE id = ?', [stage, '已签约', cid]);
    } else {
      await q('UPDATE customers SET level = ?, updated_at = NOW() WHERE id = ?', [stage, cid]);
    }
    res.json({ message: '阶段已推进', from: cust.level, to: stage });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== API: FOLLOW-UPS ====================
app.get('/api/customers/:id/followups', auth, async (req, res) => {
  try {
    const followups = await qAll(`
      SELECT f.*, a.name as agent_name,
        to_char(f.created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at
      FROM follow_ups f
      LEFT JOIN agents a ON f.agent_id = a.id
      WHERE f.customer_id = ?
      ORDER BY f.created_at DESC
    `, [req.params.id]);
    res.json({ followups });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/customers/:id/followups', auth, async (req, res) => {
  try {
    const cid = req.params.id;
    const { content, followup_type, next_action } = req.body;
    const agentId = req.user.role === 'agent' ? req.user.agent_id : (req.body.agent_id || req.user.agent_id);
    await q('INSERT INTO follow_ups (customer_id, agent_id, content, followup_type, next_action) VALUES (?,?,?,?,?)',
      [cid, agentId, content, followup_type || 'phone', next_action]);
    await q('UPDATE customers SET followup_notes = ?, updated_at = NOW() WHERE id = ?', [content, cid]);
    res.json({ message: '跟进记录已添加' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== API: STATS - OVERVIEW ====================
app.get('/api/stats/overview', auth, async (req, res) => {
  try {
    const { store_id, agent_id } = req.query;
    let where = scopeWhere(req, 'c');
    const params = [];
    if (store_id && req.user.role === 'admin') { where += ' AND c.store_id = ?'; params.push(store_id); }
    if (agent_id && (req.user.role === 'admin' || req.user.role === 'manager')) { where += ' AND c.agent_id = ?'; params.push(agent_id); }

    const p1 = (await qGet(`SELECT COUNT(*)::int as c FROM customers c WHERE ${where} AND c.level = 'P1'`, params)).c;
    const p2 = (await qGet(`SELECT COUNT(*)::int as c FROM customers c WHERE ${where} AND c.level = 'P2'`, params)).c;
    const p3 = (await qGet(`SELECT COUNT(*)::int as c FROM customers c WHERE ${where} AND c.level = 'P3'`, params)).c;
    const p4 = (await qGet(`SELECT COUNT(*)::int as c FROM customers c WHERE ${where} AND c.level = 'P4'`, params)).c;
    const total = p1 + p2 + p3 + p4;
    const visited = p2 + p3 + p4;
    const deposited = p3 + p4;

    const conversionRates = {
      p1ToP2: total > 0 ? +((visited / total) * 100).toFixed(1) : 0,
      p2ToP3: visited > 0 ? +((deposited / visited) * 100).toFixed(1) : 0,
      p3ToP4: deposited > 0 ? +((p4 / deposited) * 100).toFixed(1) : 0,
      p1ToP4: total > 0 ? +((p4 / total) * 100).toFixed(1) : 0,
    };

    const ratingDist = await qAll(`SELECT c.rating, COUNT(*)::int as c FROM customers c WHERE ${where} GROUP BY c.rating ORDER BY c DESC`, params);
    const followupStats = await qGet(`
      SELECT
        COUNT(DISTINCT c.id)::int as customers_with_fu,
        COUNT(f.id)::int as total_fu,
        COALESCE(AVG(fu_count.cnt), 0)::float as avg_fu
      FROM customers c
      LEFT JOIN follow_ups f ON f.customer_id = c.id
      LEFT JOIN (SELECT customer_id, COUNT(*)::int as cnt FROM follow_ups GROUP BY customer_id) fu_count ON fu_count.customer_id = c.id
      WHERE ${where}
    `, params);

    res.json({
      total, p1, p2, p3, p4, visited, deposited,
      conversionRates,
      ratingDist,
      followupStats: {
        customersWithFollowup: followupStats.customers_with_fu || 0,
        totalFollowups: followupStats.total_fu || 0,
        avgFollowup: followupStats.avg_fu ? +parseFloat(followupStats.avg_fu).toFixed(1) : 0,
        followupRate: total > 0 ? +(((followupStats.customers_with_fu || 0) / total) * 100).toFixed(1) : 0,
      },
    });
  } catch (e) { console.error('overview error:', e.message); res.status(500).json({ error: e.message }); }
});

// ==================== API: STORE-LEVEL FUNNEL ====================
app.get('/api/stats/store-funnel', auth, async (req, res) => {
  try {
    let where = '1=1';
    const params = [];
    if (req.user.role === 'manager') { where = 'c.store_id = ?'; params.push(req.user.store_id); }
    else if (req.user.role === 'agent') { where = 'c.agent_id = ?'; params.push(req.user.agent_id); }

    const stores = await qAll(`
      SELECT s.id, s.name, s.city,
        COUNT(c.id)::int as total,
        COALESCE(SUM(CASE WHEN c.level = 'P1' THEN 1 ELSE 0 END), 0)::int as p1,
        COALESCE(SUM(CASE WHEN c.level = 'P2' THEN 1 ELSE 0 END), 0)::int as p2,
        COALESCE(SUM(CASE WHEN c.level = 'P3' THEN 1 ELSE 0 END), 0)::int as p3,
        COALESCE(SUM(CASE WHEN c.level = 'P4' THEN 1 ELSE 0 END), 0)::int as p4
      FROM stores s
      LEFT JOIN customers c ON c.store_id = s.id AND ${where}
      GROUP BY s.id, s.name, s.city
      ORDER BY s.city, s.id
    `, params);

    const result = stores.map(s => {
      const total = s.total || 0;
      const visited = (s.p2 || 0) + (s.p3 || 0) + (s.p4 || 0);
      const deposited = (s.p3 || 0) + (s.p4 || 0);
      return {
        ...s,
        rate_p1_p2: total > 0 ? +((visited / total) * 100).toFixed(1) : 0,
        rate_p2_p3: visited > 0 ? +((deposited / visited) * 100).toFixed(1) : 0,
        rate_p3_p4: deposited > 0 ? +(((s.p4 || 0) / deposited) * 100).toFixed(1) : 0,
        rate_overall: total > 0 ? +(((s.p4 || 0) / total) * 100).toFixed(1) : 0,
      };
    });
    res.json({ stores: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== API: AGENT-LEVEL FUNNEL ====================
app.get('/api/stats/agent-funnel', auth, async (req, res) => {
  try {
    const { store_id } = req.query;
    let where = '1=1';
    const params = [];
    if (req.user.role === 'manager') { where = 'a.store_id = ?'; params.push(req.user.store_id); }
    else if (req.user.role === 'agent') { where = 'a.id = ?'; params.push(req.user.agent_id); }
    else if (store_id) { where = 'a.store_id = ?'; params.push(store_id); }

    const agents = await qAll(`
      SELECT a.id, a.name, s.name as store_name, s.city,
        COUNT(c.id)::int as total,
        COALESCE(SUM(CASE WHEN c.level = 'P1' THEN 1 ELSE 0 END), 0)::int as p1,
        COALESCE(SUM(CASE WHEN c.level = 'P2' THEN 1 ELSE 0 END), 0)::int as p2,
        COALESCE(SUM(CASE WHEN c.level = 'P3' THEN 1 ELSE 0 END), 0)::int as p3,
        COALESCE(SUM(CASE WHEN c.level = 'P4' THEN 1 ELSE 0 END), 0)::int as p4
      FROM agents a
      JOIN stores s ON a.store_id = s.id
      LEFT JOIN customers c ON c.agent_id = a.id
      WHERE ${where}
      GROUP BY a.id, a.name, s.name, s.city
      ORDER BY total DESC
    `, params);

    const result = agents.map(a => {
      const total = a.total || 0;
      const visited = (a.p2 || 0) + (a.p3 || 0) + (a.p4 || 0);
      const deposited = (a.p3 || 0) + (a.p4 || 0);
      return {
        ...a,
        rate_p1_p2: total > 0 ? +((visited / total) * 100).toFixed(1) : 0,
        rate_p2_p3: visited > 0 ? +((deposited / visited) * 100).toFixed(1) : 0,
        rate_p3_p4: deposited > 0 ? +(((a.p4 || 0) / deposited) * 100).toFixed(1) : 0,
        rate_overall: total > 0 ? +(((a.p4 || 0) / total) * 100).toFixed(1) : 0,
      };
    });
    res.json({ agents: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== API: CHANNEL DISTRIBUTION ====================
app.get('/api/stats/channel-distribution', auth, async (req, res) => {
  try {
    let where = scopeWhere(req, 'c');
    const params = [];
    if (req.query.store_id && req.user.role === 'admin') { where += ' AND c.store_id = ?'; params.push(req.query.store_id); }

    const dist = await qAll(`
      SELECT c.channel,
        COUNT(*)::int as total,
        COALESCE(SUM(CASE WHEN c.level = 'P4' THEN 1 ELSE 0 END), 0)::int as signed,
        COALESCE(SUM(CASE WHEN c.level = 'P1' THEN 1 ELSE 0 END), 0)::int as p1,
        COALESCE(SUM(CASE WHEN c.level = 'P2' THEN 1 ELSE 0 END), 0)::int as p2,
        COALESCE(SUM(CASE WHEN c.level = 'P3' THEN 1 ELSE 0 END), 0)::int as p3
      FROM customers c
      WHERE ${where} AND c.channel IS NOT NULL
      GROUP BY c.channel
      ORDER BY total DESC
    `, params);

    const grandTotal = dist.reduce((s, d) => s + d.total, 0);
    const result = dist.map(d => ({
      ...d,
      sign_rate: d.total > 0 ? +((d.signed / d.total) * 100).toFixed(1) : 0,
      total_pct: grandTotal > 0 ? +((d.total / grandTotal) * 100).toFixed(1) : 0,
      signed_pct: grandTotal > 0 ? +((d.signed / grandTotal) * 100).toFixed(1) : 0,
    }));
    res.json({ distribution: result, grandTotal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== API: DAILY TREND ====================
app.get('/api/stats/daily-trend', auth, async (req, res) => {
  try {
    let where = scopeWhere(req, 'c');
    const params = [];
    if (req.query.store_id && req.user.role === 'admin') { where += ' AND c.store_id = ?'; params.push(req.query.store_id); }

    const trend = await qAll(`
      SELECT c.add_date,
        COUNT(*)::int as total,
        COALESCE(SUM(CASE WHEN c.level = 'P1' THEN 1 ELSE 0 END), 0)::int as p1,
        COALESCE(SUM(CASE WHEN c.level = 'P2' THEN 1 ELSE 0 END), 0)::int as p2,
        COALESCE(SUM(CASE WHEN c.level = 'P3' THEN 1 ELSE 0 END), 0)::int as p3,
        COALESCE(SUM(CASE WHEN c.level = 'P4' THEN 1 ELSE 0 END), 0)::int as p4
      FROM customers c
      WHERE ${where} AND c.add_date IS NOT NULL
      GROUP BY c.add_date
      ORDER BY c.add_date
    `, params);
    res.json({ trend });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== API: TOP RANKINGS ====================
app.get('/api/stats/top', auth, async (req, res) => {
  try {
    let where = '1=1';
    const params = [];
    if (req.user.role === 'manager') { where = 'c.store_id = ?'; params.push(req.user.store_id); }
    else if (req.user.role === 'agent') { where = 'c.agent_id = ?'; params.push(req.user.agent_id); }

    const topStores = await qAll(`
      SELECT s.name, s.city,
        COUNT(c.id)::int as total,
        COALESCE(SUM(CASE WHEN c.level = 'P4' THEN 1 ELSE 0 END), 0)::int as signed
      FROM stores s
      LEFT JOIN customers c ON c.store_id = s.id AND ${where}
      GROUP BY s.id, s.name, s.city
      ORDER BY signed DESC, total DESC
      LIMIT 5
    `, params);

    const topAgents = await qAll(`
      SELECT a.name, st.name as store, st.city,
        COUNT(c.id)::int as total,
        COALESCE(SUM(CASE WHEN c.level = 'P4' THEN 1 ELSE 0 END), 0)::int as signed
      FROM agents a
      JOIN stores st ON a.store_id = st.id
      LEFT JOIN customers c ON c.agent_id = a.id AND ${where}
      GROUP BY a.id, a.name, st.name, st.city
      ORDER BY signed DESC, total DESC
      LIMIT 5
    `, params);

    const topChannels = await qAll(`
      SELECT c.channel,
        COUNT(*)::int as total,
        COALESCE(SUM(CASE WHEN c.level = 'P4' THEN 1 ELSE 0 END), 0)::int as signed
      FROM customers c
      WHERE ${where} AND c.channel IS NOT NULL
      GROUP BY c.channel
      ORDER BY signed DESC, total DESC
      LIMIT 5
    `, params);

    res.json({ topStores, topAgents, topChannels });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== API: CUSTOMER PROFILE ====================
app.get('/api/stats/customer-profile', auth, async (req, res) => {
  try {
    let where = scopeWhere(req, 'c');
    const params = [];
    if (req.query.store_id && req.user.role === 'admin') { where += ' AND c.store_id = ?'; params.push(req.query.store_id); }

    const [ratingDist, budgetDist, objectionDist, unitTypeDist, channelDist, demoDist, ageDist] = await Promise.all([
      qAll(`SELECT c.rating, COUNT(*)::int as c FROM customers c WHERE ${where} GROUP BY c.rating ORDER BY c DESC`, params),
      qAll(`SELECT c.budget, COUNT(*)::int as c FROM customers c WHERE ${where} AND c.budget IS NOT NULL AND c.budget != '' GROUP BY c.budget ORDER BY c DESC`, params),
      qAll(`SELECT c.objection, COUNT(*)::int as c FROM customers c WHERE ${where} AND c.objection IS NOT NULL AND c.objection != '' GROUP BY c.objection ORDER BY c DESC`, params),
      qAll(`SELECT c.unit_type, COUNT(*)::int as c FROM customers c WHERE ${where} AND c.unit_type IS NOT NULL AND c.unit_type != '' GROUP BY c.unit_type ORDER BY c DESC`, params),
      qAll(`SELECT c.channel, COUNT(*)::int as c FROM customers c WHERE ${where} AND c.channel IS NOT NULL AND c.channel != '' GROUP BY c.channel ORDER BY c DESC`, params),
      qAll(`SELECT c.demographic, COUNT(*)::int as c FROM customers c WHERE ${where} AND c.demographic IS NOT NULL AND c.demographic != '' GROUP BY c.demographic ORDER BY c DESC`, params),
      qAll(`SELECT c.age_range, COUNT(*)::int as c FROM customers c WHERE ${where} AND c.age_range IS NOT NULL AND c.age_range != '' GROUP BY c.age_range ORDER BY c DESC`, params),
    ]);

    res.json({ ratingDist, budgetDist, objectionDist, unitTypeDist, channelDist, demoDist, ageDist });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== API: ANALYSIS ====================
app.get('/api/stats/analysis', auth, async (req, res) => {
  try {
    let where = scopeWhere(req, 'c');
    const params = [];
    if (req.query.store_id && req.user.role === 'admin') { where += ' AND c.store_id = ?'; params.push(req.query.store_id); }

    const total = (await qGet(`SELECT COUNT(*)::int as c FROM customers c WHERE ${where}`, params)).c;
    const signed = (await qGet(`SELECT COUNT(*)::int as c FROM customers c WHERE ${where} AND c.level = 'P4'`, params)).c;
    const churned = (await qGet(`SELECT COUNT(*)::int as c FROM customers c WHERE ${where} AND c.rating = 'D:已流失'`, params)).c;
    const noFollowup = (await qGet(`SELECT COUNT(*)::int as c FROM customers c WHERE ${where} AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.customer_id = c.id)`, params)).c;

    const highValue = await qAll(`
      SELECT c.*, a.name as agent_name, s.name as store_name, s.city as store_city,
        (SELECT COUNT(*)::int FROM follow_ups f WHERE f.customer_id = c.id) as fu_count,
        to_char(c.created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at
      FROM customers c
      JOIN agents a ON c.agent_id = a.id
      JOIN stores s ON c.store_id = s.id
      WHERE ${where} AND (c.rating LIKE 'A%' OR c.rating = '已签约' OR c.level IN ('P3','P4'))
      ORDER BY CASE WHEN c.rating = '已签约' THEN 1 WHEN c.rating LIKE 'A%' THEN 2 WHEN c.level = 'P3' THEN 3 ELSE 4 END, c.add_date DESC
      LIMIT 20
    `, params);

    const churnRisk = await qAll(`
      SELECT c.*, a.name as agent_name, s.name as store_name, s.city as store_city,
        (SELECT COUNT(*)::int FROM follow_ups f WHERE f.customer_id = c.id) as fu_count,
        to_char(c.created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at
      FROM customers c
      JOIN agents a ON c.agent_id = a.id
      JOIN stores s ON c.store_id = s.id
      WHERE ${where} AND (c.rating = 'D:已流失' OR (c.rating LIKE 'C%' AND c.level = 'P1'))
      ORDER BY c.add_date ASC
      LIMIT 20
    `, params);

    const needFollowUp = await qAll(`
      SELECT c.*, a.name as agent_name, s.name as store_name, s.city as store_city,
        (SELECT COUNT(*)::int FROM follow_ups f WHERE f.customer_id = c.id) as fu_count,
        to_char(c.created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at
      FROM customers c
      JOIN agents a ON c.agent_id = a.id
      JOIN stores s ON c.store_id = s.id
      WHERE ${where} AND (c.rating LIKE 'B%' OR c.rating LIKE 'C%' OR c.rating = '低需求' OR c.rating IS NULL)
        AND c.level != 'P4'
      ORDER BY CASE WHEN c.rating LIKE 'B%' THEN 1 WHEN c.rating LIKE 'C%' THEN 2 ELSE 3 END, fu_count ASC
      LIMIT 30
    `, params);

    const channelPerf = await qAll(`
      SELECT c.channel, COUNT(*)::int as total,
        COALESCE(SUM(CASE WHEN c.level = 'P4' THEN 1 ELSE 0 END), 0)::int as signed,
        COALESCE(SUM(CASE WHEN c.level = 'P1' THEN 1 ELSE 0 END), 0)::int as p1
      FROM customers c WHERE ${where} AND c.channel IS NOT NULL
      GROUP BY c.channel ORDER BY total DESC
    `, params);

    const storePerf = await qAll(`
      SELECT s.name, s.city, COUNT(c.id)::int as total,
        COALESCE(SUM(CASE WHEN c.level = 'P4' THEN 1 ELSE 0 END), 0)::int as signed
      FROM stores s
      LEFT JOIN customers c ON c.store_id = s.id AND ${where}
      GROUP BY s.id, s.name, s.city
      ORDER BY signed DESC
    `, params);

    // Generate suggestions
    const suggestions = [];
    const overallRate = total > 0 ? +((signed / total) * 100).toFixed(1) : 0;
    const churnRate = total > 0 ? +((churned / total) * 100).toFixed(1) : 0;
    const noFuRate = total > 0 ? +((noFollowup / total) * 100).toFixed(1) : 0;

    if (overallRate < 15) {
      suggestions.push({ priority: 'high', title: `整体转化率${overallRate}%偏低，需重点优化P1→P2到访环节`, detail: '建议加强线索邀约话术培训，提升到访率' });
    }
    if (noFuRate > 20) {
      suggestions.push({ priority: 'high', title: `${noFollowup}条线索零跟进（占比${noFuRate}%）`, detail: '建议制定跟进SOP，确保每条线索至少2次跟进' });
    }
    if (churnRate > 20) {
      suggestions.push({ priority: 'high', title: `流失率${churnRate}%偏高`, detail: '分析流失原因，针对性优化产品与话术' });
    }

    const topObj = await qGet(`SELECT c.objection, COUNT(*)::int as c FROM customers c WHERE ${where} AND c.objection IS NOT NULL AND c.objection != '' GROUP BY c.objection ORDER BY c DESC LIMIT 1`, params);
    if (topObj) {
      suggestions.push({ priority: 'medium', title: `首要抗性「${topObj.objection}」${topObj.c}例`, detail: '建议针对性准备应对话术与替代方案' });
    }

    const bestCh = channelPerf.filter(c => c.total >= 5).sort((a, b) => (b.signed / b.total) - (a.signed / a.total))[0];
    const worstCh = channelPerf.filter(c => c.total >= 5).sort((a, b) => (a.signed / a.total) - (b.signed / b.total))[0];
    if (bestCh && bestCh.signed > 0) {
      suggestions.push({ priority: 'low', title: `高效渠道「${bestCh.channel}」签约率${+((bestCh.signed / bestCh.total) * 100).toFixed(1)}%`, detail: '建议加大该渠道投入' });
    }
    if (worstCh && worstCh.channel !== bestCh?.channel) {
      suggestions.push({ priority: 'medium', title: `低效渠道「${worstCh.channel}」签约率仅${worstCh.signed > 0 ? +((worstCh.signed / worstCh.total) * 100).toFixed(1) : 0}%`, detail: '建议评估投入产出比，考虑调整预算' });
    }

    if (storePerf.length > 1) {
      const best = storePerf[0];
      const worst = storePerf.filter(s => s.total > 5).sort((a, b) => (a.signed / a.total) - (b.signed / b.total))[0];
      if (best && worst && best.name !== worst.name) {
        suggestions.push({ priority: 'medium', title: `门店差距：${best.name}转化率${best.total > 0 ? +((best.signed / best.total) * 100).toFixed(1) : 0}% vs ${worst.name}${worst.total > 0 ? +((worst.signed / worst.total) * 100).toFixed(1) : 0}%`, detail: '建议组织优秀门店经验分享' });
      }
    }

    const avgFuRow = await qGet(`SELECT COALESCE(AVG(fu_count), 0)::float as avg FROM (SELECT c.id, COUNT(f.id)::int as fu_count FROM customers c LEFT JOIN follow_ups f ON f.customer_id = c.id WHERE ${where} GROUP BY c.id) t`, params);
    if (avgFuRow && parseFloat(avgFuRow.avg) < 1.5) {
      suggestions.push({ priority: 'low', title: `平均跟进${parseFloat(avgFuRow.avg).toFixed(1)}次/客户`, detail: '建议提升至2次以上，增加客户触达频次' });
    }

    res.json({
      total,
      summary: {
        highValueCount: highValue.length,
        churnRiskCount: churnRisk.length,
        needFollowUpCount: needFollowUp.length,
        overallRate, churnRate, noFollowupRate: noFuRate,
        avgFollowup: avgFuRow ? +parseFloat(avgFuRow.avg).toFixed(1) : 0,
      },
      highValue, churnRisk, needFollowUp, channelPerf, storePerf, suggestions,
    });
  } catch (e) { console.error('analysis error:', e.message); res.status(500).json({ error: e.message }); }
});

// ==================== HEALTH ====================
app.get('/health', async (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ ok: false, status: 'starting', db: false });
  }
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true, time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, status: 'db_error', db: false, error: e.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// SPA fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== STARTUP ====================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function connectWithRetry(maxRetries = 10) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      console.log(`[DB] 连接尝试 ${i}/${maxRetries}...`);
      const result = await pool.query('SELECT 1 as ok');
      if (result.rows[0].ok === 1) {
        console.log('[DB] 连接成功');
        return true;
      }
    } catch (e) {
      console.error(`[DB] 连接失败 ${i}/${maxRetries}:`, e.message);
      if (i === maxRetries) throw e;
      const waitSec = Math.min(i * 2, 10);
      console.log(`[DB] 等待 ${waitSec} 秒后重试...`);
      await sleep(waitSec * 1000);
    }
  }
  return false;
}

let dbReady = false;

async function start() {
  console.log('[START] 服务启动中...');
  console.log(`[START] PORT=${PORT}`);
  console.log(`[START] DATABASE_URL=${process.env.DATABASE_URL ? '已配置' : '未配置'}`);

  // 先启动 HTTP 监听，这样 Railway 不会因 "Application failed to respond" 判定失败
  const server = app.listen(PORT, () => {
    console.log(`[HTTP] 监听端口 ${PORT}`);
  });

  // 数据库连接重试
  try {
    await connectWithRetry(10);
    console.log('[DB] 初始化 schema...');
    await initSchema();
    console.log('[DB] 检查 seed 数据...');
    await seed();
    dbReady = true;
    console.log('[START] 服务就绪 (DB ready)');
  } catch (e) {
    console.error('[START] 数据库初始化失败 (但 HTTP 仍在线):', e.message);
    console.error('[START] 健康检查端点 /health 会返回 503，部署可能判定失败');
  }

  // 优雅退出
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      console.log(`[EXIT] 收到 ${sig} 信号，关闭中...`);
      server.close();
      try { await pool.end(); } catch (e) {}
      process.exit(0);
    });
  }
}

start();
