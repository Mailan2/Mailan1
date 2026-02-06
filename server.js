const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const uuid = require('uuid');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(
  session({
    secret: 'super_secret_key', // Измените на сильный секретный ключ
    resave: false,
    saveUninitialized: true,
  })
);
app.use(flash());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Настройка базы данных
const db = new Database('skins.db');
db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    is_verified BOOLEAN DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS skins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    author TEXT,
    filename TEXT NOT NULL,
    views INTEGER DEFAULT 0,
    user_id INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
)`);

// Настройка Multer для загрузок
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${uuid.v4()}${path.extname(file.originalname)}`),
});
const uploadMulter = multer({
  storage,
  limits: { fileSize: 1024 * 1024 }, // 1 МБ
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.png') {
      return cb(new Error('Можно загружать только файлы .png (скины Minecraft)'));
    }
    return cb(null, true);
  },
});

// Middleware для проверки авторизации
function isAuthenticated(req, res, next) {
  if (req.session.userId) return next();
  req.flash('error', 'Пожалуйста, войдите в аккаунт для загрузки');
  res.redirect('/login');
}

// Helper для проверки прав администратора
function isAdmin(req) {
  return Boolean(req.session && req.session.isVerified);
}

// Маршруты
app.get('/', (req, res) => {
  const stmt = db.prepare('SELECT * FROM skins');
  const skins = stmt.all();
  const allMessages = Object.values(req.flash()).flat(); // Собираем все сообщения в массив
  res.render('index', { skins, messages: allMessages, user: req.session });
});

app.get('/skin/:skinId', (req, res) => {
  const { skinId } = req.params;
  const stmt = db.prepare('SELECT * FROM skins WHERE id = ?');
  const skin = stmt.get(skinId);

  if (!skin) return res.status(404).send('Скин не найден');

  if (!req.session.viewedSkins) req.session.viewedSkins = [];
  if (!req.session.viewedSkins.includes(skinId)) {
    db.prepare('UPDATE skins SET views = views + 1 WHERE id = ?').run(skinId);
    req.session.viewedSkins.push(skinId);
  }

  res.render('view_skin', { skin, user: req.session });
});

app.get('/uploads/:filename', (req, res) => {
  res.sendFile(path.join(__dirname, 'uploads', req.params.filename));
});

app.get('/download/:skinId', (req, res) => {
  const { skinId } = req.params;
  const stmt = db.prepare('SELECT * FROM skins WHERE id = ?');
  const skin = stmt.get(skinId);

  if (!skin) return res.status(404).send('Скин не найден');

  const filePath = path.join(__dirname, 'uploads', skin.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Файл не найден');

  return res.download(filePath, `${skin.name}.png`);
});

// Регистрация
app.get('/register', (req, res) => {
  const messages = Object.values(req.flash()).flat();
  res.render('register', { messages });
});

app.post('/register', (req, res) => {
  const { username, email, password } = req.body;
  bcrypt.hash(password, 10, (err, hash) => {
    if (err) return res.status(500).send('Ошибка');
    try {
      db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)')
        .run(username, email, hash);
      req.flash('success', 'Регистрация успешна! Пожалуйста, войдите.');
      res.redirect('/login');
    } catch (e) {
      req.flash('error', 'Имя пользователя или email уже существует');
      res.redirect('/register');
    }
  });
});

// Логин
app.get('/login', (req, res) => {
  const messages = Object.values(req.flash()).flat();
  res.render('login', { messages });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  const user = stmt.get(username);
  if (!user) {
    req.flash('error', 'Неверные данные');
    return res.redirect('/login');
  }
  return bcrypt.compare(password, user.password, (err, match) => {
    if (!match) {
      req.flash('error', 'Неверные данные');
      return res.redirect('/login');
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isVerified = user.is_verified;
    req.flash('success', 'Вход выполнен!');
    return res.redirect('/');
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  req.flash('success', 'Вы вышли');
  res.redirect('/');
});

// Загрузка
app.get('/upload', isAuthenticated, (req, res) => {
  const messages = Object.values(req.flash()).flat();
  res.render('upload', { messages });
});

app.post('/upload', isAuthenticated, (req, res) => {
  uploadMulter.single('file')(req, res, (err) => {
    const { name, description, author } = req.body;
    const file = req.file;

    if (err) {
      req.flash('error', err.message || 'Ошибка загрузки файла');
      return res.redirect('/upload');
    }

    if (!file || !name || !description) {
      req.flash('error', 'Отсутствуют поля или файл');
      return res.redirect('/upload');
    }

    const skinId = uuid.v4();
    db.prepare('INSERT INTO skins (id, name, description, author, filename, user_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(skinId, name, description, author || '', file.filename, req.session.userId);

    req.flash('success', 'Скин успешно загружен!');
    return res.redirect('/');
  });
});

// Верификация пользователя (только для verified пользователей)
app.get('/verify/:userId', (req, res) => {
  if (!req.session.isVerified) return res.status(403).send('Доступ запрещён');
  const { userId } = req.params;
  db.prepare('UPDATE users SET is_verified = 1 WHERE id = ?').run(userId);
  req.flash('success', 'Пользователь верифицирован');
  res.redirect('/');
});

// Удаление скина (автор или verified)
app.get('/delete/:skinId', isAuthenticated, (req, res) => {
  const { skinId } = req.params;
  const stmt = db.prepare('SELECT * FROM skins WHERE id = ?');
  const skin = stmt.get(skinId);

  if (!skin) return res.status(404).send('Скин не найден');

  // Проверка прав
  if (req.session.userId !== skin.user_id && !isAdmin(req)) {
    req.flash('error', 'У вас нет прав на удаление этого скина');
    return res.redirect(`/skin/${skinId}`);
  }

  // Удаляем файл
  const filePath = path.join(__dirname, 'uploads', skin.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  // Удаляем из БД
  db.prepare('DELETE FROM skins WHERE id = ?').run(skinId);

  req.flash('success', 'Скин успешно удалён!');
  return res.redirect('/');
});

// Удаление всех скинов (только админ)
app.post('/admin/delete-all', isAuthenticated, (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Доступ запрещён');

  const skins = db.prepare('SELECT filename FROM skins').all();
  for (const skin of skins) {
    const filePath = path.join(__dirname, 'uploads', skin.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  db.prepare('DELETE FROM skins').run();
  req.flash('success', 'Все скины удалены');
  return res.redirect('/');
});

app.listen(port, () => console.log(`Сервер запущен на http://localhost:${port}`));
