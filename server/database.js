const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Создаем папку data если её нет
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'scout.db'));

// Включаем WAL mode для лучшей производительности
db.pragma('journal_mode = WAL');

// Создаем таблицы
db.exec(`
    -- Пользователи системы
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
    );

    -- Настройки мониторинга для каждого пользователя
    CREATE TABLE IF NOT EXISTS monitor_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        folder_name TEXT NOT NULL,
        keywords TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        monitoring_started_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Отслеживаемые чаты (кеш)
    CREATE TABLE IF NOT EXISTS monitored_chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        chat_title TEXT,
        chat_type TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, chat_id)
    );

    -- История отправленных уведомлений (для дедупликации)
    CREATE TABLE IF NOT EXISTS sent_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, chat_id, message_id)
    );

    -- Временные сессии авторизации
    CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        phone TEXT,
        api_id TEXT,
        api_hash TEXT,
        phone_code_hash TEXT,
        step TEXT DEFAULT 'phone',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
    );
`);

// Функции для работы с пользователями
const userQueries = {
    create: db.prepare(`
        INSERT INTO users (telegram_user_id, telegram_username, phone, api_id, api_hash, session_string, bot_chat_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    
    getByTelegramId: db.prepare(`
        SELECT * FROM users WHERE telegram_user_id = ?
    `),
    
    getByPhone: db.prepare(`
        SELECT * FROM users WHERE phone = ?
    `),
    
    getById: db.prepare(`
        SELECT * FROM users WHERE id = ?
    `),
    
    updateSession: db.prepare(`
        UPDATE users SET session_string = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `),
    
    updateBotChatId: db.prepare(`
        UPDATE users SET bot_chat_id = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?
    `),
    
    setActive: db.prepare(`
        UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `),
    
    getAllActive: db.prepare(`
        SELECT * FROM users WHERE is_active = 1
    `),
    
    delete: db.prepare(`
        DELETE FROM users WHERE id = ?
    `)
};

// Функции для работы с настройками мониторинга
const monitorQueries = {
    create: db.prepare(`
        INSERT INTO monitor_settings (user_id, folder_name, keywords, monitoring_started_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `),
    
    getByUserId: db.prepare(`
        SELECT * FROM monitor_settings WHERE user_id = ? AND is_active = 1
    `),
    
    update: db.prepare(`
        UPDATE monitor_settings SET folder_name = ?, keywords = ? WHERE user_id = ?
    `),
    
    setActive: db.prepare(`
        UPDATE monitor_settings SET is_active = ? WHERE user_id = ?
    `),
    
    delete: db.prepare(`
        DELETE FROM monitor_settings WHERE user_id = ?
    `)
};

// Функции для работы с отслеживаемыми чатами
const chatQueries = {
    add: db.prepare(`
        INSERT OR REPLACE INTO monitored_chats (user_id, chat_id, chat_title, chat_type)
        VALUES (?, ?, ?, ?)
    `),
    
    getByUserId: db.prepare(`
        SELECT * FROM monitored_chats WHERE user_id = ?
    `),
    
    deleteByUserId: db.prepare(`
        DELETE FROM monitored_chats WHERE user_id = ?
    `),
    
    count: db.prepare(`
        SELECT COUNT(*) as count FROM monitored_chats WHERE user_id = ?
    `)
};

// Функции для работы с уведомлениями
const notificationQueries = {
    add: db.prepare(`
        INSERT OR IGNORE INTO sent_notifications (user_id, chat_id, message_id)
        VALUES (?, ?, ?)
    `),
    
    exists: db.prepare(`
        SELECT 1 FROM sent_notifications WHERE user_id = ? AND chat_id = ? AND message_id = ?
    `),
    
    cleanup: db.prepare(`
        DELETE FROM sent_notifications WHERE sent_at < datetime('now', '-7 days')
    `)
};

// Функции для работы с сессиями авторизации
const authQueries = {
    create: db.prepare(`
        INSERT INTO auth_sessions (id, phone, api_id, api_hash, step, expires_at)
        VALUES (?, ?, ?, ?, 'phone', datetime('now', '+30 minutes'))
    `),
    
    get: db.prepare(`
        SELECT * FROM auth_sessions WHERE id = ? AND expires_at > datetime('now')
    `),
    
    updateStep: db.prepare(`
        UPDATE auth_sessions SET step = ?, phone_code_hash = ? WHERE id = ?
    `),
    
    delete: db.prepare(`
        DELETE FROM auth_sessions WHERE id = ?
    `),
    
    cleanup: db.prepare(`
        DELETE FROM auth_sessions WHERE expires_at < datetime('now')
    `)
};

// Экспорт
module.exports = {
    db,
    users: {
        create: (telegramUserId, username, phone, apiId, apiHash, sessionString, botChatId) => {
            return userQueries.create.run(telegramUserId, username, phone, apiId, apiHash, sessionString, botChatId);
        },
        getByTelegramId: (telegramUserId) => userQueries.getByTelegramId.get(telegramUserId),
        getByPhone: (phone) => userQueries.getByPhone.get(phone),
        getById: (id) => userQueries.getById.get(id),
        updateSession: (id, sessionString) => userQueries.updateSession.run(sessionString, id),
        updateBotChatId: (telegramUserId, botChatId) => userQueries.updateBotChatId.run(botChatId, telegramUserId),
        setActive: (id, isActive) => userQueries.setActive.run(isActive ? 1 : 0, id),
        getAllActive: () => userQueries.getAllActive.all(),
        delete: (id) => userQueries.delete.run(id)
    },
    monitors: {
        create: (userId, folderName, keywords) => {
            return monitorQueries.create.run(userId, folderName, JSON.stringify(keywords));
        },
        getByUserId: (userId) => {
            const result = monitorQueries.getByUserId.get(userId);
            if (result) {
                result.keywords = JSON.parse(result.keywords);
            }
            return result;
        },
        update: (userId, folderName, keywords) => {
            return monitorQueries.update.run(folderName, JSON.stringify(keywords), userId);
        },
        setActive: (userId, isActive) => monitorQueries.setActive.run(isActive ? 1 : 0, userId),
        delete: (userId) => monitorQueries.delete.run(userId)
    },
    chats: {
        add: (userId, chatId, chatTitle, chatType) => {
            return chatQueries.add.run(userId, chatId, chatTitle, chatType);
        },
        getByUserId: (userId) => chatQueries.getByUserId.all(userId),
        deleteByUserId: (userId) => chatQueries.deleteByUserId.run(userId),
        count: (userId) => chatQueries.count.get(userId).count
    },
    notifications: {
        add: (userId, chatId, messageId) => {
            return notificationQueries.add.run(userId, chatId, messageId);
        },
        exists: (userId, chatId, messageId) => {
            return !!notificationQueries.exists.get(userId, chatId, messageId);
        },
        cleanup: () => notificationQueries.cleanup.run()
    },
    auth: {
        create: (id, phone, apiId, apiHash) => {
            return authQueries.create.run(id, phone, apiId, apiHash);
        },
        get: (id) => authQueries.get.get(id),
        updateStep: (id, step, phoneCodeHash = null) => {
            return authQueries.updateStep.run(step, phoneCodeHash, id);
        },
        delete: (id) => authQueries.delete.run(id),
        cleanup: () => authQueries.cleanup.run()
    }
};
