// --- State ---
let todos = [];
let currentFilter = 'all';
let editingId = null;
let selectedPriority = 'normal';
let _autoRefreshTimer = null;

// --- Helpers ---
function localDateStr(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}
function todayStr() { return localDateStr(new Date()); }
function tomorrowStr() { const d = new Date(); d.setDate(d.getDate() + 1); return localDateStr(d); }

// --- DOM ---
const $ = (sel) => document.querySelector(sel);
const todoList = $('#todo-list');
const emptyState = $('#empty-state');
const modal = $('#modal');
const statsEl = $('#stats');
const toastEl = $('#toast');
const quickInput = $('#quick-input');
const quickSend = $('#quick-send');

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  registerSW();
  // Retry logic for Cloudflare JS challenge: try up to 3 times with delay
  loadTodosWithRetry(3, 1500);
});

// --- API ---
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  const text = await res.text();
  // Handle non-JSON responses (e.g. Cloudflare challenge page)
  if (!res.ok || (!text.trimStart().startsWith('{') && !text.trimStart().startsWith('['))) {
    console.warn('API error:', res.status, text.slice(0, 100));
    return { success: false, message: '网络异常，请刷新重试' };
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    console.warn('JSON parse error:', e.message);
    return { success: false, message: '数据解析异常' };
  }
}

async function loadTodos() {
  const result = await api('GET', '/todos');
  if (result.success) {
    todos = result.data;
    render();
  }
}

async function loadTodosWithRetry(retries, delay) {
  for (let i = 0; i < retries; i++) {
    const result = await api('GET', '/todos');
    if (result.success) {
      todos = result.data;
      render();
      return;
    }
    if (i < retries - 1) {
      await new Promise(r => setTimeout(r, delay));
    }
  }
  // Last attempt: show empty state with error message
  render();
  showToast('无法加载数据，请检查网络后刷新');
}

async function createTodo(data) {
  const result = await api('POST', '/todos', data);
  if (result.success) {
    todos.unshift(result.data);
    render();
    showToast('已添加');
  }
}

async function updateTodo(id, data) {
  const result = await api('PUT', '/todos/' + id, data);
  if (result.success) {
    const idx = todos.findIndex(t => t.id === id);
    if (idx !== -1) todos[idx] = result.data;
    render();
    showToast('已更新');
  }
}

async function deleteTodo(id) {
  const result = await api('DELETE', '/todos/' + id);
  if (result.success) {
    todos = todos.filter(t => t.id !== id);
    render();
    showToast('已删除');
  }
}

async function toggleComplete(id) {
  const result = await api('POST', '/todos/' + id + '/complete');
  if (result.success) {
    const idx = todos.findIndex(t => t.id === id);
    if (idx !== -1) todos[idx] = result.data;
    render();
  }
}

// --- Render ---
function render() {
  const filtered = todos.filter(t => {
    if (currentFilter === 'active') return !t.completed;
    if (currentFilter === 'completed') return t.completed;
    return true;
  });

  // Stats
  const activeCount = todos.filter(t => !t.completed).length;
  const completedCount = todos.filter(t => t.completed).length;
  statsEl.textContent = activeCount + ' 待完成';

  if (filtered.length === 0) {
    todoList.innerHTML = '';
    todoList.appendChild(createEmptyState());
    return;
  }

  // Group by date
  const groups = {};
  const today = todayStr();
  const tomorrow = tomorrowStr();

  filtered.forEach(t => {
    const dateKey = t.dueDate || 'no-date';
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(t);
  });

  // Sort date keys
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    if (a === 'no-date') return 1;
    if (b === 'no-date') return -1;
    return a.localeCompare(b);
  });

  todoList.innerHTML = '';
  sortedKeys.forEach(dateKey => {
    const group = document.createElement('div');
    group.className = 'date-group';

    // Date label
    if (dateKey !== 'no-date') {
      const label = document.createElement('div');
      label.className = 'date-label';
      if (dateKey === today) label.textContent = '📅 今天';
      else if (dateKey === tomorrow) label.textContent = '📅 明天';
      else {
        const d = new Date(dateKey + 'T00:00:00');
        const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        label.textContent = `📅 ${d.getMonth() + 1}月${d.getDate()}日 ${weekdays[d.getDay()]}`;
      }
      group.appendChild(label);
    }

    groups[dateKey].forEach(todo => {
      group.appendChild(createTodoItem(todo));
    });

    todoList.appendChild(group);
  });
}

function createTodoItem(todo) {
  const el = document.createElement('div');
  el.className = 'todo-item' + (todo.completed ? ' completed' : '');
  if (todo.priority === 'urgent' || todo.priority === 'high') {
    el.setAttribute('data-priority', todo.priority);
  }

  // Checkbox
  const checkbox = document.createElement('div');
  checkbox.className = 'checkbox';
  checkbox.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
  checkbox.onclick = (e) => { e.stopPropagation(); toggleComplete(todo.id); };

  // Content
  const content = document.createElement('div');
  content.className = 'todo-content';

  const title = document.createElement('div');
  title.className = 'todo-title';
  title.textContent = todo.title;
  content.appendChild(title);

  // Meta tags
  const meta = document.createElement('div');
  meta.className = 'todo-meta';

  if (todo.dueTime) {
    const tag = document.createElement('span');
    tag.className = 'todo-tag tag-time';
    tag.textContent = '⏰ ' + todo.dueTime;
    meta.appendChild(tag);
  }

  if (todo.priority === 'high') {
    const tag = document.createElement('span');
    tag.className = 'todo-tag tag-priority-high';
    tag.textContent = '⬆ 高';
    meta.appendChild(tag);
  } else if (todo.priority === 'urgent') {
    const tag = document.createElement('span');
    tag.className = 'todo-tag tag-priority-urgent';
    tag.textContent = '🔴 紧急';
    meta.appendChild(tag);
  }

  if (todo.source === 'wecom') {
    const tag = document.createElement('span');
    tag.className = 'todo-tag tag-source';
    tag.textContent = '💬 企业微信';
    meta.appendChild(tag);
  }

  if (meta.children.length > 0) content.appendChild(meta);

  // Delete button
  const del = document.createElement('button');
  del.className = 'btn-delete';
  del.innerHTML = '&times;';
  del.onclick = (e) => {
    e.stopPropagation();
    if (confirm('确认删除「' + todo.title + '」？')) {
      deleteTodo(todo.id);
    }
  };

  // Click to edit
  el.onclick = () => openEditModal(todo);

  el.appendChild(checkbox);
  el.appendChild(content);
  el.appendChild(del);
  return el;
}

function createEmptyState() {
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.innerHTML = `
    <div class="empty-icon">📋</div>
    <p>还没有待办事项</p>
    <p class="empty-hint">点击右上角 + 添加，或在企业微信发消息</p>
  `;
  return el;
}

// --- Modal ---
let _modalAutoDetected = false;

function openAddModal() {
  editingId = null;
  selectedPriority = 'normal';
  _modalAutoDetected = false;
  $('#modal-title').textContent = '添加待办';
  $('#input-title').value = '';
  $('#input-date').value = todayStr();
  $('#input-time').value = '';
  $('#input-reminder').value = '';
  $('#title-hint').textContent = '';
  updatePriorityUI();
  modal.classList.add('show');
  document.body.classList.add('modal-open');
  setTimeout(() => $('#input-title').focus(), 300);
}

function openEditModal(todo) {
  editingId = todo.id;
  selectedPriority = todo.priority || 'normal';
  _modalAutoDetected = false;
  $('#modal-title').textContent = '编辑待办';
  $('#input-title').value = todo.title;
  $('#input-date').value = todo.dueDate || '';
  $('#input-time').value = todo.dueTime || '';
  $('#input-reminder').value = todo.reminder ? todo.reminder.slice(0, 16) : '';
  $('#title-hint').textContent = '';
  updatePriorityUI();
  modal.classList.add('show');
  document.body.classList.add('modal-open');
}

function closeModal() {
  modal.classList.remove('show');
  document.body.classList.remove('modal-open');
  editingId = null;
}

// Auto-detect time when typing in modal title input
// KEY: directly fill date/time fields so they're correct at save time
function onModalTitleInput() {
  const text = $('#input-title').value.trim();
  if (!text) {
    $('#title-hint').textContent = '';
    return;
  }
  const parsed = parseQuickInput(text);
  if (parsed.dueDate || parsed.dueTime) {
    // Auto-fill the form fields with parsed values
    if (parsed.dueDate) $('#input-date').value = parsed.dueDate;
    if (parsed.dueTime) $('#input-time').value = parsed.dueTime;

    // Show human-readable hint
    let hint = '';
    if (parsed.dueDate) {
      const today = todayStr();
      const tomorrow = tomorrowStr();
      if (parsed.dueDate === today) hint += '今天';
      else if (parsed.dueDate === tomorrow) hint += '明天';
      else {
        const d = new Date(parsed.dueDate + 'T00:00:00');
        const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
        hint += (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + weekdays[d.getDay()];
      }
    }
    if (parsed.dueTime) {
      hint += ' ' + parsed.dueTime;
    }
    $('#title-hint').textContent = '✅ 已自动设置：' + hint;
    _modalAutoDetected = true;
  } else {
    $('#title-hint').textContent = '';
    _modalAutoDetected = false;
  }
}

function updatePriorityUI() {
  document.querySelectorAll('.priority-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.priority === selectedPriority);
  });
}

// --- Events ---
function bindEvents() {
  // Add button
  $('#btn-add').onclick = openAddModal;

  // Close modal
  $('#btn-close').onclick = closeModal;
  $('#btn-cancel').onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };

  // Save
  $('#btn-save').onclick = () => {
    const rawTitle = $('#input-title').value.trim();
    if (!rawTitle) {
      showToast('请输入待办内容');
      return;
    }

    // If auto-detected, use cleaned title (time words removed)
    let finalTitle = rawTitle;
    if (_modalAutoDetected) {
      const parsed = parseQuickInput(rawTitle);
      finalTitle = parsed.title;
    }
    if (!finalTitle) finalTitle = rawTitle;

    // Read directly from form fields (already auto-filled by onModalTitleInput)
    const finalDate = $('#input-date').value || null;
    const finalTime = $('#input-time').value || null;

    // Auto-set reminder 10min before if we have date+time
    let finalReminder = $('#input-reminder').value
      ? new Date($('#input-reminder').value).toISOString()
      : null;
    if (!finalReminder && finalTime && finalDate) {
      const reminderDate = new Date(finalDate + 'T' + finalTime + ':00');
      reminderDate.setMinutes(reminderDate.getMinutes() - 10);
      if (reminderDate > new Date()) {
        finalReminder = reminderDate.toISOString();
      }
    }

    const data = {
      title: finalTitle,
      dueDate: finalDate,
      dueTime: finalTime,
      reminder: finalReminder,
      priority: selectedPriority
    };

    if (editingId) {
      updateTodo(editingId, data);
    } else {
      createTodo(data);
    }
    closeModal();
  };

  // Priority buttons
  document.querySelectorAll('.priority-btn').forEach(btn => {
    btn.onclick = () => {
      selectedPriority = btn.dataset.priority;
      updatePriorityUI();
    };
  });

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      render();
    };
  });

  // Keyboard: Enter to save in modal
  $('#input-title').onkeydown = (e) => {
    if (e.key === 'Enter') $('#btn-save').click();
  };

  // Auto-detect time when typing in modal title
  $('#input-title').addEventListener('input', onModalTitleInput);

  // --- Quick Input Bar ---
  quickInput.addEventListener('input', () => {
    quickSend.disabled = !quickInput.value.trim();
  });

  // Quick send: create todo immediately with just a title
  quickSend.addEventListener('click', quickSubmit);
  quickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && quickInput.value.trim()) {
      e.preventDefault();
      quickSubmit();
    }
  });

  // Auto-refresh every 60s (reduced from 30s to lower battery/network usage on mobile)
  if (document.visibilityState !== 'hidden') {
    if (_autoRefreshTimer) clearInterval(_autoRefreshTimer);
    _autoRefreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') loadTodos();
    }, 60000);
  }

  // Pause refresh when tab is hidden, resume when visible
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadTodos();
  });
}

async function quickSubmit() {
  const title = quickInput.value.trim();
  if (!title) return;

  quickInput.value = '';
  quickSend.disabled = true;

  // Try to parse natural language for date/time
  const parsed = parseQuickInput(title);

  try {
    const result = await api('POST', '/todos', {
      title: parsed.title,
      dueDate: parsed.dueDate,
      dueTime: parsed.dueTime,
      priority: 'normal'
    });
    if (result.success) {
      todos.unshift(result.data);
      render();
      showToast('已添加');
    } else {
      showToast(result.message || '添加失败');
      quickInput.value = title; // restore input
    }
  } catch (e) {
    showToast('添加失败，请检查网络');
    quickInput.value = title; // restore input
  }

  quickInput.blur();
}

// Convert Chinese numerals to Arabic for time parsing
function normalizeChineseNumbers(text) {
  const map = {'零':'0','一':'1','二':'2','两':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9'};
  let r = text;
  // 十X → 1X (e.g. 十一 → 11, 十二 → 12)
  r = r.replace(/十([一二两三四五六七八九])/g, (_, d) => '1' + map[d]);
  // X十 → X0 (e.g. 二十 → 20)
  r = r.replace(/([一二两三四五六七八九])十/g, (_, d) => map[d] + '0');
  // Standalone 十 → 10
  r = r.replace(/十/g, '10');
  // 半 → 30 (minutes)
  r = r.replace(/半/g, '30');
  // Single digits
  r = r.replace(/[零一二两三四五六七八九]/g, d => map[d] || d);
  return r;
}

function parseQuickInput(text) {
  const now = new Date();
  let dueDate = null;
  let dueTime = null;
  let cleanTitle = text;

  // Normalize Chinese numerals to Arabic so regex can match
  const normalized = normalizeChineseNumbers(text);

  // === Pattern 1: Weekday (周X / 下周X) with optional time ===
  const weekdayRe = /(?:下周|这周|本周)?\s*(周[一二三四五六日天0-9]|星期[一二三四五六日天0-9])\s*(?:上午|下午|早上|晚上)?\s*(\d{1,2})?\s*[点时:：]?\s*(?:钟)?\s*(\d{1,2})?/u;
  const weekdayMatch = normalized.match(weekdayRe);
  if (weekdayMatch) {
    const dayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0, '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 };
    const dayStr = weekdayMatch[1];
    let targetDay = null;
    for (const [k, v] of Object.entries(dayMap)) {
      if (dayStr.includes(k)) { targetDay = v; break; }
    }
    if (targetDay !== null) {
      const isNextWeek = text.includes('下周');
      const d = new Date(now);
      let diff = (targetDay - d.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      if (isNextWeek) diff += 7;
      d.setDate(d.getDate() + diff);
      dueDate = localDateStr(d);

      if (weekdayMatch[2]) {
        let hour = parseInt(weekdayMatch[2]);
        const period = text.match(/(上午|下午|早上|晚上)/);
        if (period) {
          const p = period[1];
          if ((p === '下午' || p === '晚上') && hour < 12) hour += 12;
        }
        const min = weekdayMatch[3] ? parseInt(weekdayMatch[3]) : 0;
        dueTime = String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0');
      }
    }

    // Clean title
    cleanTitle = text.replace(/(?:下周|这周|本周)?\s*(?:周[一二三四五六日天\d]|星期[一二三四五六日天\d])\s*/g, '')
                     .replace(/(?:上午|下午|早上|晚上)/g, '')
                     .replace(/[一二两三四五六七八九十\d]{1,4}\s*[点时:：]?\s*(?:钟)?\s*[一二两三四五六七八九十\d]{0,4}\s*分?/g, '')
                     .replace(/\s+/g, ' ').trim();
    if (!cleanTitle) cleanTitle = text;
    return { title: cleanTitle, dueDate, dueTime };
  }

  // === Pattern 2: Relative day (今天/明天/后天/大后天/N天后) + time ===
  const timeRe = /(?:今天|明日|明天|后天|大后天|(\d+)天后)?\s*(?:上午|下午|早上|晚上)?\s*(\d{1,2})\s*[点时:：]?\s*(?:钟)?\s*(\d{1,2})?/u;

  const timeMatch = normalized.match(timeRe);
  if (timeMatch && timeMatch[2]) {
    let daysAhead = 0;
    if (timeMatch[1]) daysAhead = parseInt(timeMatch[1]);
    else if (normalized.includes('明天') || normalized.includes('明日')) daysAhead = 1;
    else if (normalized.includes('后天')) daysAhead = 2;
    else if (normalized.includes('大后天')) daysAhead = 3;

    if (daysAhead > 0) {
      const d = new Date(now.getTime() + daysAhead * 86400000);
      dueDate = localDateStr(d);
    }

    let hour = parseInt(timeMatch[2]);
    if (normalized.includes('下午') || normalized.includes('晚上')) {
      if (hour < 12) hour += 12;
    }
    const min = timeMatch[3] ? parseInt(timeMatch[3]) : 0;
    dueTime = String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0');

    // Clean up title
    cleanTitle = text.replace(/(?:今天|明日|明天|后天|大后天|\d+天后)\s*/g, '')
                     .replace(/(?:上午|下午|早上|晚上)/g, '')
                     .replace(/[一二两三四五六七八九十\d]{1,4}\s*[点时:：]?\s*(?:钟)?\s*[一二两三四五六七八九十\d]{0,4}\s*分?/g, '')
                     .replace(/\s+/g, ' ').trim();
    if (!cleanTitle) cleanTitle = text;
  }

  return { title: cleanTitle, dueDate, dueTime };
}

// --- Toast ---
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toastEl.classList.remove('show'), 2000);
}

// --- PWA ---
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}
