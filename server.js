require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const nodemailer = require('nodemailer');

const app = express();

// --- Middleware ---
app.use(express.json());
app.use(cookieParser());
app.use(cors());
app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_session_secret',
  resave: false,
  saveUninitialized: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // set to true in production with HTTPS
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  }
}));

// --- MongoDB ---
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) console.error('⚠ MONGODB_URI not set in .env');
mongoose.connect(MONGODB_URI, { autoIndex: true })
  .then(() => console.log('✔ Mongo connected'))
  .catch(err => console.error('❌ Mongo error:', err.message));

// --- Schemas ---
const UserSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  name: String,
  email: { type: String, unique: true, sparse: true },
  emailVerified: { type: Boolean, default: false },
}, { timestamps: true });

const CartSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  items: [{ name: String, price: Number, image: String, id: String }]
}, { timestamps: true });

const OtpSchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  type: { type: String, enum: ['email', 'sms'], required: true },
  target: { type: String, required: true },
  code: { type: String, required: true },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

const LogSchema = new mongoose.Schema({
  sessionId: String,
  action: String,
  data: mongoose.Schema.Types.Mixed
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);
const Cart = mongoose.model('Cart', CartSchema);
const Otp = mongoose.model('Otp', OtpSchema);
const Log = mongoose.model('Log', LogSchema);

// --- Email transporter ---
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
  },
});

// --- Helpers ---
function ensureSession(req, res, next) {
  if (!req.session) return res.status(500).json({ error: 'No session' });
  req.sessionId = req.session.id;
  next();
}
function genCode() {
  return '' + Math.floor(100000 + Math.random() * 900000);
}
function validateEmail(email) {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email);
}

// --- Admin /database route ---
app.get('/database', async (req, res) => {
  try {
    const password = req.query.password;
    if (!password) return res.status(401).send('❌ Unauthorized: no password');
    if (password !== process.env.ADMIN_PASSWORD) return res.status(401).send('❌ Unauthorized: wrong password');

    const users = await User.find().sort({ createdAt: -1 }).lean();
    const carts = await Cart.find().sort({ createdAt: -1 }).lean();

    const renderValue = val => {
      if (val instanceof Date) return val.toLocaleString();
      if (Array.isArray(val)) {
        return val.map(v => {
          if (v && v.name && v.price) {
            return `Name: ${v.name}, Price: ${v.price}, Image: ${v.image}, ID: ${v.id}`;
          }
          if (typeof v === 'object' && v !== null) {
            return Object.entries(v).map(([k,v2]) => `${k}: ${v2}`).join(', ');
          }
          return String(v ?? '');
        }).join(' | ');
      }
      if (typeof val === 'object' && val !== null) {
        return Object.entries(val).map(([k,v2]) => `${k}: ${v2}`).join(', ');
      }
      return String(val ?? '');
    };

    const truncate = (str, max = 60) => {
      if (!str) return '';
      if (str.length <= max) return str;
      return `<span class="tooltip" title="${str}">${str.slice(0,max)}...
                <button class="copyBtn" data-value="${str}">📋</button>
              </span>`;
    };

    const hiddenKeysGlobal = ['_id','sessionId','__v'];
    const hiddenKeysCarts = ['userId', ...hiddenKeysGlobal];

    const renderTable = (title, data, id, hiddenKeys, colorEmailVerified=false) => {
      if (!data || data.length === 0) return `<h2>${title}</h2><p>No records found</p>`;
      const keys = [...new Set(data.flatMap(obj => Object.keys(obj)))].filter(k => !hiddenKeys.includes(k));
      const rows = data.map(row => 
        `<tr>
          ${keys.map(k => {
            let val = truncate(renderValue(row[k]));
            if (colorEmailVerified && k==='emailVerified') {
              val = row[k] ? `<span style="color:green;font-weight:bold;">true</span>` : `<span style="color:red;font-weight:bold;">false</span>`;
            }
            return `<td>${val}</td>`;
          }).join('')}
          <td><button class="deleteBtn" data-id="${row._id}" data-collection="${title.toLowerCase()}">🗑 Delete</button></td>
        </tr>`).join('');
      
      return `
        <h2>${title}</h2>
        <input type="text" class="searchBox" data-table="${id}" placeholder="🔍 Search ${title}..." />
        <div class="table-container">
          <table id="${id}">
            <thead>
              <tr>${keys.map(k => `<th>${k}</th>`).join('')}<th>Actions</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    };

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Admin Database Viewer</title>
        <style>
          body { font-family: Arial; margin: 20px; background: #f4f4f4; }
          h1 { text-align: center; }
          h2 { margin-top: 40px; }
          .table-container { overflow-x: auto; margin-bottom: 40px; }
          table { border-collapse: collapse; width: 100%; background:white; box-shadow:0 2px 4px rgba(0,0,0,0.1);}
          th, td { border:1px solid #ccc; padding:8px; font-size:14px; vertical-align:top; max-width:300px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
          th { background:#222; color:white; text-transform:capitalize;}
          tr:nth-child(even) {background:#f9f9f9;}
          tr:hover {background:#f1f1f1;}
          .searchBox { margin:10px 0; padding:6px; width:100%; max-width:300px; border:1px solid #ccc; border-radius:4px;}
          .tooltip { position: relative; cursor: help; }
          .copyBtn { display:none; margin-left:5px; padding:0 3px; font-size:12px; cursor:pointer; }
          .tooltip:hover .copyBtn { display:inline-block; }
          .toast { visibility:hidden; min-width:200px; background:#333;color:#fff;text-align:center;border-radius:5px;padding:10px;position:fixed;top:20px;right:20px; z-index:1000; }
          .toast.show { visibility:visible; animation:fadein 0.5s, fadeout 0.5s 2.5s; }
          @keyframes fadein { from {opacity:0;} to {opacity:1;} }
          @keyframes fadeout { from {opacity:1;} to {opacity:0;} }
          @media(max-width:600px){table,th,td{font-size:12px;} .searchBox{width:100%;}}
        </style>
      </head>
      <body>
        <h1>📊 Admin Database Viewer</h1>
        ${renderTable('Users', users, 'usersTable', hiddenKeysGlobal, true)}
        ${renderTable('Carts', carts, 'cartsTable', hiddenKeysCarts)}

        <div id="toast" class="toast"></div>

        <script>
          const showToast = msg => {
            const t = document.getElementById('toast');
            t.textContent = msg;
            t.className = 'toast show';
            setTimeout(()=>{t.className='toast';},3000);
          };

          document.querySelectorAll('.searchBox').forEach(input=>{
            input.addEventListener('keyup',function(){
              const tableId = this.getAttribute('data-table');
              const filter = this.value.toLowerCase();
              const rows = document.querySelectorAll('#'+tableId+' tbody tr');
              rows.forEach(row=>{
                row.style.display = row.innerText.toLowerCase().includes(filter)?'':'none';
              });
            });
          });

          document.body.addEventListener('click', e=>{
            if(e.target.classList.contains('copyBtn')){
              const val = e.target.dataset.value;
              navigator.clipboard.writeText(val).then(()=>showToast('Copied to clipboard!'));
            }

            if(e.target.classList.contains('deleteBtn')){
              const id = e.target.dataset.id;
              const collection = e.target.dataset.collection;
              if(confirm('Are you sure you want to delete this record?')){
                fetch('/api/admin/delete', {
                  method:'POST',
                  headers:{'Content-Type':'application/json'},
                  body: JSON.stringify({id, collection})
                }).then(r=>r.json()).then(res=>{
                  if(res.ok){ showToast('Deleted successfully!'); setTimeout(()=>location.reload(),500);}
                  else showToast('Delete failed');
                }).catch(err=>{console.error(err); showToast('Delete failed');});
              }
            }
          });
        </script>
      </body>
      </html>
    `;

    res.send(html);
  } catch(err){
    console.error('GET /database error:', err);
    res.status(500).send('Server error');
  }
});

// --- Delete API for admin ---
app.post('/api/admin/delete', async (req,res)=>{
  try{
    const {id, collection} = req.body;
    if(!id || !collection) return res.status(400).json({ok:false,error:'Missing id or collection'});
    let model;
    if(collection==='users') model=User;
    else if(collection==='carts') model=Cart;
    else return res.status(400).json({ok:false,error:'Invalid collection'});
    await model.deleteOne({_id:id});
    res.json({ok:true});
  } catch(err){
    console.error('DELETE error:',err);
    res.status(500).json({ok:false,error:'Server error'});
  }
});


// --- Cart Routes ---
app.get('/api/Cart', ensureSession, async (req, res) => {
  try {
    const user = await User.findOne({ sessionId: req.sessionId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const cart = await Cart.findOne({ userId: user._id });
    res.json({ cart: cart?.items || [] });
  } catch (e) {
    console.error('GET /api/Cart error:', e);
    res.status(500).json({ error: 'Failed to load cart' });
  }
});

app.post('/api/Cart', ensureSession, async (req, res) => {
  try {
    const user = await User.findOne({ sessionId: req.sessionId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const items = Array.isArray(req.body.cart) ? req.body.cart : (Array.isArray(req.body) ? req.body : []);
    const updated = await Cart.findOneAndUpdate(
      { userId: user._id },
      { $set: { items } },
      { upsert: true, new: true }
    );

    res.json({ ok: true, cart: updated.items });
  } catch (e) {
    console.error('POST /api/Cart error:', e);
    res.status(500).json({ error: 'Failed to save cart' });
  }
});

// ✅ Clearing cart after checkout
app.post('/api/Cart/clear', ensureSession, async (req, res) => {
  try {
    const user = await User.findOne({ sessionId: req.sessionId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    await Cart.findOneAndUpdate(
      { userId: user._id },
      { $set: { items: [] } },
      { upsert: true }
    );
    res.json({ ok: true, message: 'Cart cleared after checkout' });
  } catch (e) {
    console.error('POST /api/Cart/clear error:', e);
    res.status(500).json({ error: 'Failed to clear cart' });
  }
});

// --- OTP & Auth ---
app.post('/api/send-email-otp', ensureSession, async (req, res) => {
  try {
    console.log('📨 /api/send-email-otp called');

    const { email } = req.body;
    if (!email || !validateEmail(email)) {
      console.log('❌ Invalid email received:', email);
      return res.status(400).json({ error: 'Invalid email' });
    }

    const code = genCode();
    await Otp.create({
      sessionId: req.sessionId,
      type: 'email',
      target: email,
      code,
      expiresAt: new Date(Date.now() + 60 * 1000),
    });

    // Force log
    process.stdout.write(`📧 OTP generated for ${email}: ${code}\n`);

    if (transporter?.options?.auth?.user) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Your verification code',
        text: `Your code is ${code}. It expires in 60 seconds.`,
      });
      console.log(`📤 OTP email attempted to ${email}`);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/send-email-otp error:', e);
    res.status(500).json({ error: 'Failed to send email code' });
  }
});


app.post('/api/verify-email-otp', ensureSession, async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code required' });
    }

    const otp = await Otp.findOne({
      sessionId: req.sessionId,
      type: 'email',
      target: email
    }).sort({ createdAt: -1 });

    if (!otp) return res.status(400).json({ error: 'Code not found' });
    if (otp.expiresAt < new Date()) return res.status(400).json({ error: 'Code expired' });
    if (otp.code !== code) return res.status(400).json({ error: 'Invalid code' });

    const existingUser = await User.findOneAndUpdate(
      { email },
      { $set: { sessionId: req.sessionId, emailVerified: true } },
      { upsert: true, new: true }
    );

    await Otp.deleteOne({ _id: otp._id });
    console.log(`✅ OTP verified successfully for ${email}`);

    res.json({ ok: true, user: existingUser });
  } catch (e) {
    console.error('POST /api/verify-email-otp error:', e);
    res.status(500).json({ error: 'Verify email failed' });
  }
});

// --- Signup ---
app.post('/api/signup', ensureSession, async (req, res) => {
  try {
    const { name, email, emailVerified } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Missing fields' });

    const user = await User.findOneAndUpdate(
      { sessionId: req.sessionId },
      { $set: { name, email, emailVerified: !!emailVerified } },
      { upsert: true, new: true }
    );

    await Cart.findOneAndUpdate(
      { userId: user._id },
      { $setOnInsert: { items: [] } },
      { upsert: true }
    );

    res.json({ ok: true, user });
  } catch (e) {
    console.error('POST /api/signup error:', e);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// --- Logging ---
app.post('/api/userAction', ensureSession, async (req, res) => {
  try {
    await Log.create({ sessionId: req.sessionId, action: 'userAction', data: req.body });
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/userAction error:', e);
    res.status(500).json({ error: 'Log failed' });
  }
});

app.post('/api/Log', ensureSession, async (req, res) => {
  try {
    await Log.create({ sessionId: req.sessionId, action: 'buttonClick', data: req.body });
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/Log error:', e);
    res.status(500).json({ error: 'Log failed' });
  }
});

// --- Frontend serving ---
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const p = path.join(__dirname, 'public', 'laphub.min.html');
  console.log('Serving file:', p);
  res.sendFile(p);
});

// --- Start ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✔ Server running at http://localhost:${PORT}`));
