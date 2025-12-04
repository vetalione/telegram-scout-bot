const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

// Создаем папку data если её нет
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'scout.db');

let db = null;
let SQL = null;
let isInitialized = false;

// Инициализация базы данных
async function initDatabase() {
    if (isInitialized && db) return db;
    
    SQL = await initSqlJs();
    
    // Загружаем существующую БД или создаем новую
    try {
        if (fs.existsSync(dbPath)) {
            const fileBuffer = fs.readFileSync(dbPath);
            db = new SQL.Database(fileBuffer);
        } else {
            db = new SQL.Database();
        }
    } catch (e) {
        db = new SQL.Database();
    }

    // Создаем таблицы
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_user_id TEXT UNIQUE,
            telegram_username TEXT,
            phone TEXT,
            api_id TEXT,
            api_hash TEXT,
            session_string TEXT,
            bot_chat_id TEXT,
            is_active INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS monitor_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            folder_name TEXT NOT NULL,
            keywords TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            monitoring_started_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS monitored_chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            chat_id TEXT NOT NULL,
            chat_title TEXT,
            chat_type TEXT,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, chat_id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS sent_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            chat_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, chat_id, message_id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS auth_sessions (
            id TEXT PRIMARY KEY,
            phone TEXT,
            api_id TEXT,
            api_hash TEXT,
            phone_code_hash TEXT,
            step TEXT DEFAULT 'phone',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME
        )
    `);

    saveDatabase();
    isInitialized = true;
    return db;
}

// Сохранение базы данных на диск
function saveDatabase() {
    if (db) {
        try {
            const data = db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(dbPath, buffer);
        } catch (e) {
            console.error('Error saving database:', e);
        }
    }
}

// Периодическое сохранение
setInterval(saveDatabase, 30000);

// Helper для выполнения запросов
function run(sql, params = []) {
    if (!db) throw new Error('Database not initialized');
    db.run(sql, params);
    saveDatabase();
}

function get(sql, params = []) {
    if (!db) throw new Error('Database not initialized');
    const stmt = db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
    }
    stmt.free();
    return null;
}

function all(sql, params = []) {
    if (!db) throw new Error('Database not initialized');
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

// Экспорт
module.exports = {
    initDatabase,
    saveDatabase,
    users: {
        create: (telegramUserId, username, phone, apiId, apiHash, sessionString, botChatId) => {
            run(`
                INSERT INTO users (telegram_user_id, telegram_username, phone, api_id, api_hash, session_string, bot_chat_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [telegramUserId, username, phone, apiId, apiHash, sessionString, botChatId]);
            return { lastInsertRowid: get('SELECT last_insert_rowid() as id').id };
        },
        getByTelegramId: (telegramUserId) => get('SELECT * FROM users WHERE telegram_user_id = ?', [telegramUserId]),
        getByPhone: (phone) => get('SELECT * FROM users WHERE phone = ?', [phone]),
        getById: (id) => get('SELECT * FROM users WHERE id = ?', [id]),
        updateSession: (id, sessionString) => {
            run('UPDATE users SET session_string = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [sessionString, id]);
        },
        updateBotChatId: (telegramUserId, botChatId) => {
            run('UPDATE users SET bot_chat_id = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?', [botChatId, telegramUserId]);
        },
        setActive: (id, isActive) => {
            run('UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [isActive ? 1 : 0, id]);
        },
        getAllActive: () => all('SELECT * FROM users WHERE is_active = 1'),
        delete: (id) => run('DELETE FROM users WHERE id = ?', [id])
    },
    monitors: {
        create: (userId, folderName, keywords) => {
            run(`
                INSERT INTO monitor_settings (user_id, folder_name, keywords, monitoring_started_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `, [userId, folderName, JSON.stringify(keywords)]);
        },
        getByUserId: (userId) => {
            const result = get('SELECT * FROM monitor_settings WHERE user_id = ? AND is_active = 1', [userId]);
            if (result) {
                result.keywords = JSON.parse(result.keywords);
            }
            return result;
        },
        update: (userId, folderName, keywords) => {
            run('UPDATE monitor_settings SET folder_name = ?, keywords = ? WHERE user_id = ?', [folderName, JSON.stringify(keywords), userId]);
        },
        setActive: (userId, isActive) => {
            run('UPDATE monitor_settings SET is_active = ? WHERE user_id = ?', [isActive ? 1 : 0, userId]);
        },
        delete: (userId) => run('DELETE FROM monitor_settings WHERE user_id = ?', [userId])
    },
    chats: {
        add: (userId, chatId, chatTitle, chatType) => {
            run(`
                INSERT OR REPLACE INTO monitored_chats (user_id, chat_id, chat_title, chat_type)
                VALUES (?, ?, ?, ?)
            `, [userId, chatId, chatTitle, chatType]);
        },
        getByUserId: (userId) => all('SELECT * FROM monitored_chats WHERE user_id = ?', [userId]),
        deleteByUserId: (userId) => run('DELETE FROM monitored_chats WHERE user_id = ?', [userId]),
        count: (userId) => {
            const result = get('SELECT COUNT(*) as count FROM monitored_chats WHERE user_id = ?', [userId]);
            return result ? result.count : 0;
        }
    },
    notifications: {
        add: (userId, chatId, messageId) => {
            try {
                run('INSERT OR IGNORE INTO sent_notifications (user_id, chat_id, message_id) VALUES (?, ?, ?)', [userId, chatId, messageId]);
            } catch (e) {}
        },
        exists: (userId, chatId, messageId) => {
            return !!get('SELECT 1 FROM sent_notifications WHERE user_id = ? AND chat_id = ? AND message_id = ?', [userId, chatId, messageId]);
        },
        cleanup: () => run("DELETE FROM sent_notifications WHERE sent_at < datetime('now', '-7 days')")
    },
    auth: {
        create: (id, phone, apiId, apiHash) => {
            run(`
                INSERT INTO auth_sessions (id, phone, api_id, api_hash, step, expires_at)
                VALUES (?, ?, ?, ?, 'phone', datetime('now', '+30 minutes'))
            `, [id, phone, apiId, apiHash]);
        },
        get: (id) => get("SELECT * FROM auth_sessions WHERE id = ? AND expires_at > datetime('now')", [id]),
        updateStep: (id, step, phoneCodeHash = null) => {
            run('UPDATE auth_sessions SET step = ?, phone_code_hash = ? WHERE id = ?', [step, phoneCodeHash, id]);
        },
        delete: (id) => run('DELETE FROM auth_sessions WHERE id = ?', [id]),
        cleanup: () => run("DELETE FROM auth_sessions WHERE expires_at < datetime('now')")
    }
};
