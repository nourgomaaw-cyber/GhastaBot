import { createClient } from '@supabase/supabase-js';
import * as tus from 'tus-js-client';
import './style.css';

const env = import.meta.env;
const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseKey = env.VITE_SUPABASE_ANON_KEY;
const app = document.querySelector('#app');

let supabase;
let user = null;
let profile = null;
let conversations = [];
let activeConversation = null;
let messageChannel = null;
let messages = [];
let busy = false;

const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const initials = s => (s || '?').trim().slice(0, 2).toUpperCase();
const time = d => new Date(d).toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'});
const humanSize = n => n < 1024**2 ? `${(n/1024).toFixed(0)} KB` : `${(n/1024**2).toFixed(1)} MB`;

function showConfigError() {
  app.innerHTML = `<main class="center"><section class="auth-card"><div class="brand-mark">G</div><h1>GUDELINO</h1><div class="brand-ar">جود لينو</div><p>منصة التواصل الخاصة بفريقك</p><div class="notice">لازم تضيف إعدادات Supabase الأول في ملف <code>.env</code>، وبعدها شغّل الموقع من جديد.</div><p class="muted">راجع ملف README.md داخل المشروع لخطوات الإعداد.</p></section></main>`;
}

function authView(mode = 'login') {
  const signup = mode === 'signup';
  app.innerHTML = `<main class="center"><form class="auth-card" id="auth-form">
    <div class="brand-mark">G</div><h1>GUDELINO</h1><div class="brand-ar">جود لينو</div><p>مساحتك الخاصة للتواصل ومشاركة الملفات</p>
    <label>البريد الإلكتروني<input name="email" type="email" required autocomplete="email" placeholder="name@example.com"></label>
    <label>كلمة المرور<input name="password" type="password" required minlength="6" autocomplete="${signup?'new-password':'current-password'}" placeholder="6 أحرف على الأقل"></label>
    ${signup ? '<label>اسم العرض<input name="displayName" required maxlength="32" placeholder="اسمك داخل الشات"></label>' : ''}
    <button class="primary" type="submit">${signup?'إنشاء حساب':'تسجيل الدخول'}</button>
    <div class="auth-error" id="auth-error"></div>
    <button class="link-button" type="button" id="switch-auth">${signup?'عندك حساب؟ سجّل الدخول':'مستخدم جديد؟ أنشئ حساب'}</button>
  </form></main>`;
  document.querySelector('#switch-auth').onclick = () => authView(signup ? 'login' : 'signup');
  document.querySelector('#auth-form').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const email = fd.get('email').trim();
    const password = fd.get('password');
    const error = document.querySelector('#auth-error');
    error.textContent = 'جارٍ التنفيذ...';
    const result = signup
      ? await supabase.auth.signUp({ email, password, options: { data: { display_name: fd.get('displayName').trim() } } })
      : await supabase.auth.signInWithPassword({ email, password });
    if (result.error) error.textContent = result.error.message;
    else if (signup && !result.data.session) error.textContent = 'تم إنشاء الحساب. افتح بريدك الإلكتروني لتأكيده، ثم سجّل الدخول.';
    else await boot();
  };
}

async function ensureProfile() {
  const { data } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
  profile = data;
  if (!profile) {
    const display_name = user.user_metadata?.display_name || user.email.split('@')[0];
    const { data: created, error } = await supabase.from('profiles').insert({id:user.id, display_name, email:user.email.toLowerCase()}).select().single();
    if (error) throw error;
    profile = created;
  }
}

async function loadConversations() {
  const { data, error } = await supabase.from('conversation_members')
    .select('conversation:conversations(id,title,type,created_at)')
    .eq('user_id', user.id);
  if (error) throw error;
  conversations = (data || []).map(x => x.conversation).filter(Boolean);
  if (!conversations.length) {
    const { data: created, error: createError } = await supabase.rpc('create_default_room');
    if (!createError && created) {
      const { data: refreshed } = await supabase.from('conversation_members')
        .select('conversation:conversations(id,title,type,created_at)').eq('user_id', user.id);
      conversations = (refreshed || []).map(x => x.conversation).filter(Boolean);
    }
  }
  if (!activeConversation || !conversations.some(c => c.id === activeConversation.id)) {
    activeConversation = conversations[0] || null;
  }
}

function shell() {
  app.innerHTML = `<div class="layout">
    <aside class="sidebar">
      <div class="side-head"><div class="brand-mark small">G</div><div><b>GUDELINO</b><small>STAFF COMMUNITY</small></div></div>
      <div class="section-title">قنوات المحادثة <button id="new-room" title="إنشاء غرفة">＋</button></div>
      <div id="conversation-list" class="conversation-list"></div>
      <div class="side-user"><div class="avatar">${esc(initials(profile.display_name))}</div><div class="user-meta"><b>${esc(profile.display_name)}</b><small>${esc(user.email)}</small></div><button id="logout" title="تسجيل الخروج">↪</button></div>
    </aside>
    <main class="chat">
      <header class="chat-head"><div><h2 id="chat-title">اختار محادثة</h2><p id="chat-subtitle">GUDELINO</p></div><button id="new-dm" class="outline">＋ محادثة خاصة</button></header>
      <section id="messages" class="messages"><div class="empty">اختار قناة من القائمة أو أنشئ واحدة.</div></section>
      <form id="composer" class="composer">
        <input id="file-input" type="file" multiple hidden>
        <button id="attach" type="button" class="attach" title="إرفاق ملف">＋</button>
        <input id="message-input" placeholder="اكتب رسالة..." maxlength="5000" autocomplete="off">
        <button class="send primary" type="submit">إرسال</button>
      </form>
      <div id="upload-status" class="upload-status"></div>
    </main>
  </div>`;
  document.querySelector('#logout').onclick = async () => { await supabase.auth.signOut(); user = null; authView(); };
  document.querySelector('#new-room').onclick = createRoom;
  document.querySelector('#new-dm').onclick = createDM;
  document.querySelector('#attach').onclick = () => document.querySelector('#file-input').click();
  document.querySelector('#file-input').onchange = e => uploadFiles([...e.target.files]);
  document.querySelector('#composer').onsubmit = sendMessage;
  renderConversationList();
  if (activeConversation) openConversation(activeConversation);
}

function renderConversationList() {
  const list = document.querySelector('#conversation-list');
  list.innerHTML = conversations.map(c => `<button class="conversation ${activeConversation?.id===c.id?'active':''}" data-id="${c.id}">
    <span class="channel-icon">${c.type==='direct'?'@':'#'}</span><span>${esc(c.title || (c.type==='direct'?'محادثة خاصة':'غرفة بدون اسم'))}</span>
  </button>`).join('') || '<p class="muted pad">لا توجد محادثات بعد.</p>';
  list.querySelectorAll('[data-id]').forEach(el => el.onclick = () => {
    const c = conversations.find(x => x.id === el.dataset.id);
    if (c) { activeConversation = c; renderConversationList(); openConversation(c); }
  });
}

async function openConversation(c) {
  activeConversation = c;
  document.querySelector('#chat-title').textContent = `${c.type==='direct'?'@':'#'} ${c.title || 'محادثة خاصة'}`;
  document.querySelector('#chat-subtitle').textContent = c.type === 'direct' ? 'محادثة خاصة' : 'قناة الفريق';
  const box = document.querySelector('#messages');
  box.innerHTML = '<div class="empty">تحميل الرسائل...</div>';
  if (messageChannel) await supabase.removeChannel(messageChannel);
  const { data, error } = await supabase.from('messages')
    .select('id,body,file_name,file_path,file_size,file_type,created_at,user_id,profile:profiles(display_name)')
    .eq('conversation_id', c.id).order('created_at', {ascending:true}).limit(150);
  if (error) { box.innerHTML = `<div class="empty">${esc(error.message)}</div>`; return; }
  messages = data || [];
  renderMessages();
  messageChannel = supabase.channel(`messages-${c.id}`)
    .on('postgres_changes', {event:'INSERT', schema:'public', table:'messages', filter:`conversation_id=eq.${c.id}`}, async payload => {
      if (messages.some(m => m.id === payload.new.id)) return;
      const { data: row } = await supabase.from('messages')
        .select('id,body,file_name,file_path,file_size,file_type,created_at,user_id,profile:profiles(display_name)')
        .eq('id', payload.new.id).single();
      if (row && activeConversation?.id === c.id) { messages.push(row); renderMessages(); }
    }).subscribe();
}

function renderMessages() {
  const box = document.querySelector('#messages');
  if (!messages.length) box.innerHTML = '<div class="empty">لسه مفيش رسائل. ابدأ المحادثة 👋</div>';
  else box.innerHTML = messages.map(m => {
    const mine = m.user_id === user.id;
    const file = m.file_path ? `<div class="file-card"><div class="file-icon">↧</div><div class="file-info"><b>${esc(m.file_name)}</b><small>${humanSize(m.file_size || 0)} · ${esc(m.file_type || 'ملف')}</small></div><button data-download="${esc(m.file_path)}" data-name="${esc(m.file_name)}">تحميل</button></div>` : '';
    return `<article class="message ${mine?'mine':''}"><div class="message-top"><b>${esc(m.profile?.display_name || 'عضو')}</b><time>${time(m.created_at)}</time></div>${m.body?`<div class="message-body">${esc(m.body).replace(/\n/g,'<br>')}</div>`:''}${file}</article>`;
  }).join('');
  box.querySelectorAll('[data-download]').forEach(btn => btn.onclick = () => downloadFile(btn.dataset.download, btn.dataset.name));
  box.scrollTop = box.scrollHeight;
}

async function sendMessage(e) {
  e.preventDefault();
  if (!activeConversation) return alert('اختار محادثة الأول.');
  const input = document.querySelector('#message-input');
  const body = input.value.trim();
  if (!body) return;
  input.disabled = true;
  const { error } = await supabase.from('messages').insert({conversation_id:activeConversation.id, user_id:user.id, body});
  input.disabled = false;
  if (error) alert(error.message); else input.value = '';
}

async function uploadFiles(files) {
  if (!files.length || !activeConversation) return;
  const status = document.querySelector('#upload-status');
  for (const file of files) {
    status.textContent = `جارٍ رفع ${file.name} (${humanSize(file.size)})...`;
    try {
      const safeName = file.name.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0,150) || 'file';
      const path = `${activeConversation.id}/${crypto.randomUUID()}-${safeName}`;
      const session = (await supabase.auth.getSession()).data.session;
      await new Promise((resolve, reject) => {
        const upload = new tus.Upload(file, {
          endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
          retryDelays: [0, 1000, 3000, 5000, 10000],
          headers: { authorization: `Bearer ${session.access_token}`, apikey: supabaseKey },
          metadata: {
            bucketName: 'chat-files',
            objectName: path,
            contentType: file.type || 'application/octet-stream',
            cacheControl: '3600'
          },
          uploadSize: file.size,
          onError: reject,
          onProgress: (sent, total) => status.textContent = `رفع ${file.name}: ${Math.round(sent/total*100)}%`,
          onSuccess: resolve
        });
        upload.start();
      });
      const { error } = await supabase.from('messages').insert({
        conversation_id:activeConversation.id, user_id:user.id, body:'',
        file_name:file.name, file_path:path, file_size:file.size, file_type:file.type || 'application/octet-stream'
      });
      if (error) throw error;
      status.textContent = `تم رفع ${file.name}`;
    } catch (err) {
      status.textContent = `فشل رفع ${file.name}: ${err.message || err}`;
    }
  }
  document.querySelector('#file-input').value = '';
  setTimeout(() => { status.textContent = ''; }, 5000);
}

async function downloadFile(path, name) {
  const { data, error } = await supabase.storage.from('chat-files').createSignedUrl(path, 300);
  if (error) return alert(error.message);
  const a = document.createElement('a');
  a.href = data.signedUrl; a.download = name || 'download'; a.target = '_blank';
  document.body.appendChild(a); a.click(); a.remove();
}

async function createRoom() {
  const title = prompt('اسم القناة الجديدة:');
  if (!title?.trim()) return;
  const { data, error } = await supabase.rpc('create_conversation', {p_title:title.trim().slice(0,50), p_type:'room'});
  if (error) return alert(error.message);
  await loadConversations(); shell();
}

async function createDM() {
  const email = prompt('اكتب البريد الإلكتروني للشخص اللي عاوز تكلمه:');
  if (!email?.trim()) return;
  const { data: target, error: findError } = await supabase.from('profiles').select('id,display_name').eq('email', email.trim().toLowerCase()).maybeSingle();
  if (findError || !target) return alert('مش لاقي حساب بالبريد ده. لازم الشخص ينشئ حساب الأول.');
  if (target.id === user.id) return alert('مينفعش تعمل محادثة مع نفسك.');
  const { data, error } = await supabase.rpc('create_direct_conversation', {p_other_user:target.id});
  if (error) return alert(error.message);
  await loadConversations(); shell();
}

async function boot() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return authView();
  user = session.user;
  try {
    await ensureProfile();
    await loadConversations();
    shell();
  } catch (e) {
    app.innerHTML = `<main class="center"><section class="auth-card"><h2>حصل خطأ في الإعداد</h2><p>${esc(e.message)}</p><p class="muted">راجع تشغيل ملف SQL وسياسات قاعدة البيانات في README.</p><button class="primary" onclick="location.reload()">إعادة المحاولة</button></section></main>`;
  }
}

if (!supabaseUrl || !supabaseKey || supabaseUrl.includes('YOUR_PROJECT')) showConfigError();
else {
  supabase = createClient(supabaseUrl, supabaseKey);
  supabase.auth.onAuthStateChange((_event, session) => {
    if (!session && user) { user = null; authView(); }
  });
  boot();
}
