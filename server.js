const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8900;

// --- Local date helper (avoids UTC offset issues) ---
function localDateStr(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}
function todayStr() { return localDateStr(new Date()); }

// --- Data ---
const DATA_DIR = path.join(__dirname, 'data');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// --- Config ---
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {
    corp_id: '',
    agent_id: '',
    secret: '',
    token: '',
    encoding_aes_key: '',
    enabled: false
  };
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// --- Todos Store ---
let _cache = null;

function loadTodos() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(TODOS_FILE)) {
      _cache = JSON.parse(fs.readFileSync(TODOS_FILE, 'utf8'));
      return _cache;
    }
  } catch (e) {}
  _cache = { todos: [] };
  fs.writeFileSync(TODOS_FILE, JSON.stringify(_cache, null, 2));
  return _cache;
}

function saveTodos(data) {
  _cache = data;
  const tmp = TODOS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, TODOS_FILE);
  } catch (e) {
    console.error('saveTodos error:', e.message);
    try {
      fs.writeFileSync(TODOS_FILE, JSON.stringify(data, null, 2));
    } catch (e2) {
      console.error('saveTodos fallback error:', e2.message);
    }
  }
}

// --- Middleware ---
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Global error handler — must be defined after routes but before app.listen
// (placed here as a declaration; actual registration happens after routes)

// --- Health ---
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', time: new Date().toISOString() });
});

// ============================================
// Todo CRUD API
// ============================================

// List all todos
app.get('/api/todos', (req, res) => {
  const data = loadTodos();
  let todos = data.todos || [];

  // Optional filters
  const { status, sort } = req.query;
  if (status === 'active') todos = todos.filter(t => !t.completed);
  if (status === 'completed') todos = todos.filter(t => t.completed);

  // Sort: default by dueDate ascending, then by createdAt descending
  todos.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const aDate = a.dueDate || '9999-12-31';
    const bDate = b.dueDate || '9999-12-31';
    if (aDate !== bDate) return aDate.localeCompare(bDate);
    if (a.dueTime && b.dueTime) return a.dueTime.localeCompare(b.dueTime);
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  res.json({ success: true, data: todos });
});

// Get single todo
app.get('/api/todos/:id', (req, res) => {
  const data = loadTodos();
  const todo = (data.todos || []).find(t => t.id === req.params.id);
  if (!todo) return res.status(404).json({ success: false, message: '待办不存在' });
  res.json({ success: true, data: todo });
});

// Create todo
app.post('/api/todos', (req, res) => {
  const { title, content, dueDate, dueTime, reminder, priority, tags } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ success: false, message: '请输入待办内容' });
  }

  const data = loadTodos();
  const todo = {
    id: uuidv4(),
    title: title.trim(),
    content: (content || '').trim(),
    dueDate: dueDate || null,
    dueTime: dueTime || null,
    reminder: reminder || null,
    priority: priority || 'normal', // low, normal, high, urgent
    tags: Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(t => t.trim()).filter(Boolean) : []),
    completed: false,
    completedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'web' // web or wecom
  };

  data.todos.push(todo);
  saveTodos(data);
  res.json({ success: true, data: todo });
});

// Update todo
app.put('/api/todos/:id', (req, res) => {
  const data = loadTodos();
  const todo = (data.todos || []).find(t => t.id === req.params.id);
  if (!todo) return res.status(404).json({ success: false, message: '待办不存在' });

  const { title, content, dueDate, dueTime, reminder, priority, tags } = req.body;
  if (title !== undefined) todo.title = title.trim();
  if (content !== undefined) todo.content = content.trim();
  if (dueDate !== undefined) todo.dueDate = dueDate || null;
  if (dueTime !== undefined) todo.dueTime = dueTime || null;
  if (reminder !== undefined) todo.reminder = reminder || null;
  if (priority !== undefined) todo.priority = priority;
  if (tags !== undefined) todo.tags = Array.isArray(tags) ? tags : String(tags).split(',').map(t => t.trim()).filter(Boolean);
  todo.updatedAt = new Date().toISOString();

  saveTodos(data);
  res.json({ success: true, data: todo });
});

// Delete todo
app.delete('/api/todos/:id', (req, res) => {
  const data = loadTodos();
  const idx = (data.todos || []).findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: '待办不存在' });
  data.todos.splice(idx, 1);
  saveTodos(data);
  res.json({ success: true });
});

// Complete todo
app.post('/api/todos/:id/complete', (req, res) => {
  const data = loadTodos();
  const todo = (data.todos || []).find(t => t.id === req.params.id);
  if (!todo) return res.status(404).json({ success: false, message: '待办不存在' });
  todo.completed = !todo.completed;
  todo.completedAt = todo.completed ? new Date().toISOString() : null;
  todo.updatedAt = new Date().toISOString();
  saveTodos(data);
  res.json({ success: true, data: todo });
});

// ============================================
// WeChat Work Integration
// ============================================

const wecomToken = () => {
  const cfg = loadConfig();
  return cfg.token || 'todo_default_token';
};

// ============================================
// WeChat Work AES Decryption
// ============================================

// EncodingAESKey is 43 chars base64 → 32 bytes AES key
function getAesKey(encodingAESKey) {
  return Buffer.from(encodingAESKey + '=', 'base64');
}

// Decrypt enterprise WeChat callback message
// Returns { msg, fromUserName, toUserName, createTime, msgType, ... }
function decryptWecomMessage(encryptedBase64, encodingAESKey) {
  const key = getAesKey(encodingAESKey);
  const encrypted = Buffer.from(encryptedBase64, 'base64');

  // AES-256-CBC, IV is first 16 bytes of key
  const iv = key.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);

  let decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  // Remove PKCS#7 padding (16-byte block)
  const pad = decrypted[decrypted.length - 1];
  if (pad >= 1 && pad <= 16) {
    decrypted = decrypted.slice(0, decrypted.length - pad);
  }

  // Structure: 16 bytes random + 4 bytes msg length (big-endian) + msg content + corp_id
  const msgLen = decrypted.readUInt32BE(16);
  const msg = decrypted.slice(20, 20 + msgLen).toString('utf8');
  const corpId = decrypted.slice(20 + msgLen).toString('utf8');

  return { msg, corpId };
}

// Verify signature
function verifyWecomSignature(token, timestamp, nonce, encrypt, msgSignature) {
  const arr = [token, timestamp, nonce, encrypt].sort();
  const hash = crypto.createHash('sha1').update(arr.join('')).digest('hex');
  return hash === msgSignature;
}

// Verify wecom callback URL (GET) — for URL verification
app.get('/api/wecom/callback', (req, res) => {
  const { msg_signature, timestamp, nonce, echostr } = req.query;
  if (!msg_signature || !timestamp || !nonce || !echostr) {
    return res.status(400).send('missing params');
  }

  const cfg = loadConfig();
  if (!cfg.token) {
    return res.status(500).send('token not configured');
  }

  try {
    // Verify signature first
    if (!verifyWecomSignature(cfg.token, timestamp, nonce, echostr, msg_signature)) {
      return res.status(403).send('signature mismatch');
    }

    // Decrypt echostr
    if (cfg.encoding_aes_key) {
      const { msg } = decryptWecomMessage(echostr, cfg.encoding_aes_key);
      res.send(msg);
    } else {
      res.send(echostr);
    }
  } catch (e) {
    console.error('GET callback verify error:', e.message);
    res.status(500).send('verify failed');
  }
});

// Receive wecom messages (POST)
// Use express.raw to capture the XML body before express.json() can interfere
app.post('/api/wecom/callback', express.raw({ type: 'application/xml', limit: '1mb' }), (req, res) => {
  const { msg_signature, timestamp, nonce } = req.query;
  const cfg = loadConfig();

  if (!cfg.enabled) {
    return res.json({ success: true });
  }

      // Parse XML body — req.body is a Buffer from express.raw
      const xmlBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      try {
        let xml2js;
        try {
          xml2js = require('xml2js');
        } catch (e) {
          console.error('xml2js module not found:', e.message);
          return res.json({ success: true });
        }
        xml2js.parseString(xmlBody, { explicitArray: false }, (err, result) => {
          if (err) {
            console.error('XML parse error:', err);
            return res.json({ success: true });
          }

          const msgNode = result.xml;
          if (!msgNode || !msgNode.Encrypt) {
            return res.json({ success: true });
          }

          // Verify signature
          if (!verifyWecomSignature(cfg.token, timestamp, nonce, msgNode.Encrypt, msg_signature)) {
            console.error('POST signature mismatch');
            return res.status(403).send('signature mismatch');
          }

          // Decrypt message
          let parsed;
          try {
            const { msg } = decryptWecomMessage(msgNode.Encrypt, cfg.encoding_aes_key);
            // Parse the decrypted XML
            xml2js.parseString(msg, { explicitArray: false }, (e2, r2) => {
              if (e2) throw e2;
              parsed = r2.xml;
            });
          } catch (e) {
            console.error('Decrypt error:', e.message);
            return res.json({ success: true });
          }

          if (!parsed || parsed.MsgType !== 'text') {
            return res.json({ success: true });
          }

          const userId = parsed.FromUserName;
          const content = parsed.Content || '';

          // Parse natural language
          const parsedTodo = parseNaturalLanguage(content);

          // Create todo
          const data = loadTodos();
          const todo = {
            id: uuidv4(),
            title: parsedTodo.title,
            content: '',
            dueDate: parsedTodo.dueDate,
            dueTime: parsedTodo.dueTime,
            reminder: parsedTodo.reminder,
            priority: 'normal',
            tags: [],
            completed: false,
            completedAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            source: 'wecom',
            wecomUserId: userId
          };
          data.todos.push(todo);
          saveTodos(data);

          // Reply to user
          const replyText = formatReply(todo);
          sendWecomMessage(userId, replyText);

          // Set reminder if applicable
          if (todo.reminder) {
            scheduleReminder(todo);
          }

          res.json({ success: true });
        });
      } catch (e) {
        console.error('Callback error:', e);
        res.json({ success: true });
      }
});

// --- Chinese Numeral to Digits ---
function cnToDigits(text) {
  const map = {'零':'0','一':'1','二':'2','两':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9'};
  let r = text;
  // 十X → 1X
  r = r.replace(/十([一二两三四五六七八九])/g, (_, d) => '1' + map[d]);
  // X十 → X0
  r = r.replace(/([一二两三四五六七八九])十/g, (_, d) => map[d] + '0');
  // Standalone 十 → 10
  r = r.replace(/十/g, '10');
  // 半 → 30 (minutes)
  r = r.replace(/半/g, '30');
  // Single digits
  r = r.replace(/[零一二两三四五六七八九]/g, d => map[d] || d);
  return r;
}

// --- Natural Language Parser ---
function parseNaturalLanguage(text) {
  const now = new Date();
  let dueDate = null;
  let dueTime = null;
  let reminder = null;
  let title = text.trim();

  // Normalize Chinese numerals to Arabic digits for pattern matching
  const normalized = cnToDigits(title);

  // Time patterns — match against normalized text (Arabic digits)
  // The "钟" after 点/时 is optional and must not block matching
  const timePatterns = [
    // 今天/明天/后天 + 时间
    { regex: /(今天|今日)\s*(上午|下午|晚上|早上)?\s*(\d{1,2})\s*[点时:：]\s*(?:钟)?\s*(\d{1,2})?/, type: 'today' },
    { regex: /(明天|明日)\s*(上午|下午|晚上|早上)?\s*(\d{1,2})\s*[点时:：]\s*(?:钟)?\s*(\d{1,2})?/, type: 'tomorrow' },
    { regex: /(后天)\s*(上午|下午|晚上|早上)?\s*(\d{1,2})\s*[点时:：]\s*(?:钟)?\s*(\d{1,2})?/, type: 'dayafter' },
    { regex: /(大后天)\s*(上午|下午|晚上|早上)?\s*(\d{1,2})\s*[点时:：]\s*(?:钟)?\s*(\d{1,2})?/, type: 'day3' },
    // N天后
    { regex: /(\d+)\s*天后\s*(上午|下午|晚上|早上)?\s*(\d{1,2})?\s*[点时:：]?\s*(?:钟)?\s*(\d{1,2})?/, type: 'nDays' },
    // 周X + 时间
    { regex: /(周[一二三四五六日天0-9]|星期[一二三四五六日天0-9])\s*(上午|下午|晚上|早上)?\s*(\d{1,2})?\s*[点时:：]?\s*(?:钟)?\s*(\d{1,2})?/, type: 'weekday' },
    // 下周X
    { regex: /下周([一二三四五六日天0-9]|星期[一二三四五六日天0-9])\s*(上午|下午|晚上|早上)?\s*(\d{1,2})?\s*[点时:：]?\s*(?:钟)?\s*(\d{1,2})?/, type: 'nextWeek' },
    // 具体日期 X月X日
    { regex: /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]\s*(上午|下午|晚上|早上)?\s*(\d{1,2})?\s*[点时:：]?\s*(?:钟)?\s*(\d{1,2})?/, type: 'specific' },
    // Time only (e.g. 一点钟, 上午三点) — no date prefix
    { regex: /(上午|下午|晚上|早上)\s*(\d{1,2})\s*[点时:：]\s*(?:钟)?\s*(\d{1,2})?/, type: 'timeonly' },
    { regex: /(\d{1,2})\s*[点时:：]\s*(?:钟)?\s*(\d{1,2})?/, type: 'timeonly' },
  ];

  // Priority
  if (/紧急|urgent|!{2,}/.test(text)) {
    title = title.replace(/紧急|urgent|!{2,}/g, '').trim();
  }

  // Parse date + time against NORMALIZED text
  for (const pattern of timePatterns) {
    const m = normalized.match(pattern.regex);
    if (m) {
      let hour = null, minute = 0, period = null;

      switch (pattern.type) {
        case 'today': {
          period = m[2];
          hour = parseInt(m[3]);
          minute = parseInt(m[4] || '0');
          dueDate = localDateStr(now);
          break;
        }
        case 'tomorrow': {
          period = m[2];
          hour = parseInt(m[3]);
          minute = parseInt(m[4] || '0');
          const d = new Date(now);
          d.setDate(d.getDate() + 1);
          dueDate = localDateStr(d);
          break;
        }
        case 'dayafter': {
          period = m[2];
          hour = parseInt(m[3]);
          minute = parseInt(m[4] || '0');
          const d = new Date(now);
          d.setDate(d.getDate() + 2);
          dueDate = localDateStr(d);
          break;
        }
        case 'day3': {
          period = m[2];
          hour = parseInt(m[3]);
          minute = parseInt(m[4] || '0');
          const d = new Date(now);
          d.setDate(d.getDate() + 3);
          dueDate = localDateStr(d);
          break;
        }
        case 'nDays': {
          const days = parseInt(m[1]);
          period = m[2];
          hour = m[3] ? parseInt(m[3]) : null;
          minute = m[4] ? parseInt(m[4]) : 0;
          const d = new Date(now);
          d.setDate(d.getDate() + days);
          dueDate = localDateStr(d);
          break;
        }
        case 'weekday': {
          const dayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0, '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 };
          const dayStr = m[1];
          let targetDay = null;
          for (const [k, v] of Object.entries(dayMap)) {
            if (dayStr.includes(k)) { targetDay = v; break; }
          }
          if (targetDay !== null) {
            period = m[2];
            hour = m[3] ? parseInt(m[3]) : null;
            minute = m[4] ? parseInt(m[4]) : 0;
            const d = new Date(now);
            const diff = (targetDay - d.getDay() + 7) % 7 || 7;
            d.setDate(d.getDate() + diff);
            dueDate = localDateStr(d);
          }
          break;
        }
        case 'nextWeek': {
          const dayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0, '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 };
          const dayStr = m[1];
          let targetDay = null;
          for (const [k, v] of Object.entries(dayMap)) {
            if (dayStr.includes(k)) { targetDay = v; break; }
          }
          if (targetDay !== null) {
            period = m[2];
            hour = m[3] ? parseInt(m[3]) : null;
            minute = m[4] ? parseInt(m[4]) : 0;
            const d = new Date(now);
            const diff = (targetDay - d.getDay() + 7) % 7 + 7;
            d.setDate(d.getDate() + diff);
            dueDate = localDateStr(d);
          }
          break;
        }
        case 'specific': {
          const month = parseInt(m[1]) - 1;
          const day = parseInt(m[2]);
          period = m[3];
          hour = m[4] ? parseInt(m[4]) : null;
          minute = m[5] ? parseInt(m[5]) : 0;
          const d = new Date(now.getFullYear(), month, day);
          if (d < now) d.setFullYear(d.getFullYear() + 1);
          dueDate = localDateStr(d);
          break;
        }
        case 'timeonly': {
          // Time without date prefix — default to today
          period = m[1] && /^(上午|下午|晚上|早上)$/.test(m[1]) ? m[1] : null;
          hour = period ? parseInt(m[2]) : parseInt(m[1]);
          minute = (period ? m[3] : m[2]) ? parseInt(period ? m[3] : m[2]) : 0;
          break;
        }
      }

      // Handle period (上午/下午/晚上/早上)
      if (period && hour !== null) {
        if ((period === '下午' || period === '晚上') && hour < 12) hour += 12;
      }

      if (hour !== null) {
        dueTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        // Set reminder 10min before
        let reminderDate = new Date(now);
        if (dueDate) {
          reminderDate = new Date(dueDate + 'T' + dueTime + ':00');
        } else {
          // Today
          reminderDate.setHours(hour, minute, 0, 0);
          if (reminderDate <= now) {
            // If time already passed, assume tomorrow
            reminderDate.setDate(reminderDate.getDate() + 1);
            dueDate = localDateStr(reminderDate);
          }
        }
        reminderDate.setMinutes(reminderDate.getMinutes() - 10);
        if (reminderDate > now) {
          reminder = reminderDate.toISOString();
        }
      }

      // Remove matched date/time from original title using flexible cleanup
      title = title
        .replace(/(?:今天|今日|明天|明日|后天|大后天|\d+天后)\s*/g, '')
        .replace(/(?:上午|下午|早上|晚上)/g, '')
        .replace(/(?:周[一二三四五六日天\d]|星期[一二三四五六日天\d])\s*/g, '')
        .replace(/(?:下周|这周|本周)\s*/g, '')
        .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]\s*/g, '')
        .replace(/[一二两三四五六七八九十\d]{1,4}\s*[点时:：]\s*(?:钟)?\s*[一二两三四五六七八九十\d]{0,4}\s*分?/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      break;
    }
  }

  // Default: if no date parsed, set to today
  if (!dueDate && !dueTime) {
    dueDate = localDateStr(now);
  }

  // If no time but has a dueDate, default reminder at dueDate 09:00
  if (dueDate && !dueTime && !reminder) {
    dueTime = '09:00';
    const reminderDate = new Date(dueDate + 'T09:00:00');
    reminderDate.setMinutes(reminderDate.getMinutes() - 10);
    if (reminderDate > now) {
      reminder = reminderDate.toISOString();
    }
  }

  // Clean up title
  title = title
    .replace(/提醒我?/g, '')
    .replace(/记得?/g, '')
    .replace(/要|需要|必须/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!title) title = text.trim();

  return { title, dueDate, dueTime, reminder };
}

// Format reply message
function formatReply(todo) {
  let reply = '已添加待办：' + todo.title;
  if (todo.dueDate) {
    const d = new Date(todo.dueDate + 'T00:00:00');
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const today = todayStr();
    const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
    const tomorrow = localDateStr(tmr);

    if (todo.dueDate === today) {
      reply += '\n日期：今天';
    } else if (todo.dueDate === tomorrow) {
      reply += '\n日期：明天';
    } else {
      reply += '\n日期：' + (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + weekdays[d.getDay()];
    }
  }
  if (todo.dueTime) {
    reply += ' ' + todo.dueTime;
  }
  if (todo.reminder) {
    const r = new Date(todo.reminder);
    reply += '\n提醒：' + r.getHours() + ':' + String(r.getMinutes()).padStart(2, '0');
  }
  reply += '\n\n✅ 在网页管理：' + (process.env.PUBLIC_URL || 'https://todo.maomaoxia.top');
  return reply;
}

// --- WeChat Work API ---
let _accessToken = null;
let _accessTokenExpiry = 0;

async function getAccessToken() {
  if (_accessToken && Date.now() < _accessTokenExpiry) return _accessToken;

  const cfg = loadConfig();
  if (!cfg.corp_id || !cfg.secret) return null;

  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${cfg.corp_id}&corpsecret=${cfg.secret}`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.access_token) {
            _accessToken = result.access_token;
            _accessTokenExpiry = Date.now() + (result.expires_in - 300) * 1000;
            resolve(_accessToken);
          } else {
            console.error('getAccessToken error:', result);
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

async function sendWecomMessage(userId, content) {
  const cfg = loadConfig();
  if (!cfg.enabled || !cfg.agent_id) return;

  const token = await getAccessToken();
  if (!token) {
    console.error('No access token, cannot send message');
    return;
  }

  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
  const body = JSON.stringify({
    touser: userId,
    msgtype: 'text',
    agentid: cfg.agent_id,
    text: { content }
  });

  return new Promise((resolve) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.errcode !== 0) {
            console.error('sendWecomMessage error:', result);
          }
          resolve(result);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      console.error('sendWecomMessage network error:', e.message);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

// --- Reminder Scheduler ---
const scheduledReminders = new Map();

function scheduleReminder(todo) {
  if (!todo.reminder) return;

  const reminderTime = new Date(todo.reminder);
  const now = new Date();
  const delay = reminderTime.getTime() - now.getTime();

  if (delay <= 0) return; // Already past

  if (scheduledReminders.has(todo.id)) return; // Already scheduled

  const timer = setTimeout(async () => {
    scheduledReminders.delete(todo.id);

    // Check if todo is still not completed
    const data = loadTodos();
    const t = (data.todos || []).find(td => td.id === todo.id);
    if (!t || t.completed) return;

    const message = `⏰ 提醒：${t.title}\n` +
      (t.dueTime ? `时间：${t.dueTime}\n` : '') +
      `别忘了处理哦~`;

    // Send to wecom user if exists
    if (t.wecomUserId) {
      await sendWecomMessage(t.wecomUserId, message);
    }
  }, delay);

  scheduledReminders.set(todo.id, timer);
}

// Restore reminders on startup
function restoreReminders() {
  const data = loadTodos();
  const now = new Date();
  let restored = 0;
  (data.todos || []).forEach(todo => {
    if (!todo.completed && todo.reminder && new Date(todo.reminder) > now) {
      scheduleReminder(todo);
      restored++;
    }
  });
  console.log(`Restored ${restored} reminders`);

  // Cleanup completed todos' timers every 30 minutes
  setInterval(() => {
    const d = loadTodos();
    const now2 = new Date();
    for (const [id, timer] of scheduledReminders) {
      const todo = (d.todos || []).find(t => t.id === id);
      if (!todo || todo.completed || new Date(todo.reminder) <= now2) {
        clearTimeout(timer);
        scheduledReminders.delete(id);
      }
    }
  }, 1800000);
}

// --- Config API (admin only) ---
function configAuth(req, res, next) {
  const pw = req.headers['x-config-password'] || req.query.password;
  const cfg = loadConfig();
  const expectedPw = cfg.token || 'todo_default_token';
  if (pw !== expectedPw) {
    return res.status(401).json({ success: false, message: '未授权' });
  }
  next();
}

app.get('/api/config', configAuth, (req, res) => {
  const cfg = loadConfig();
  // Hide sensitive fields
  res.json({
    success: true,
    data: {
      enabled: cfg.enabled,
      corp_id: cfg.corp_id ? '***' + cfg.corp_id.slice(-4) : '',
      agent_id: cfg.agent_id || '',
      has_secret: !!cfg.secret,
      has_token: !!cfg.token,
      has_aes_key: !!cfg.encoding_aes_key
    }
  });
});

app.post('/api/config', configAuth, (req, res) => {
  const cfg = loadConfig();
  const { corp_id, agent_id, secret, token, encoding_aes_key, enabled } = req.body;
  if (corp_id !== undefined) cfg.corp_id = corp_id;
  if (agent_id !== undefined) cfg.agent_id = agent_id;
  if (secret !== undefined) cfg.secret = secret;
  if (token !== undefined) cfg.token = token;
  if (encoding_aes_key !== undefined) cfg.encoding_aes_key = encoding_aes_key;
  if (enabled !== undefined) cfg.enabled = enabled;
  saveConfig(cfg);
  res.json({ success: true, message: '配置已保存' });
});

// --- Fallback to index.html ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Global error handler ---
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ success: false, message: '服务器内部错误' });
  }
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`🥔 土豆待办清单 v1.0.0 已启动: http://localhost:${PORT}`);
  restoreReminders();
  const cfg = loadConfig();
  console.log(`   企业微信: ${cfg.enabled ? '✅ 已启用' : '❌ 未启用'}`);
});

// --- Process error handlers ---
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
