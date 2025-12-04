const { Pool } = require('pg');

// Подключение к PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

let isInitialized = false;

// Инициализация базы данных
async function initDatabase() {
    if (isInitialized) return;
    
    const client = await pool.connect();
    try {
        // Создаем таблицы
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                telegram_user_id TEXT UNIQUE,
                telegram_username TEXT,
                phone TEXT,
                api_id TEXT,
                api_hash TEXT,
                session_string TEXT,
                bot_chat_id TEXT,
                is_active BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS monitor_settings (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                folder_name TEXT NOT NULL,
                keywords TEXT NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                monitoring_started_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS monitored_chats (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                chat_id TEXT NOT NULL,
                chat_title TEXT,
                chat_type TEXT,
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, chat_id)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS sent_notifications (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                chat_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, chat_id, message_id)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS auth_sessions (
                id TEXT PRIMARY KEY,
                phone TEXT,
                api_id TEXT,
                api_hash TEXT,
                phone_code_hash TEXT,
                step TEXT DEFAULT 'phone',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP
            )
        `);

        // Таблица для всех кто нажал /start (для статистики)
        await client.query(`
            CREATE TABLE IF NOT EXISTS bot_users (
                id SERIAL PRIMARY KEY,
                telegram_user_id TEXT UNIQUE,
                telegram_username TEXT,
                first_name TEXT,
                last_name TEXT,
                language_code TEXT,
                first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Таблица статистики обработанных сообщений
        await client.query(`
            CREATE TABLE IF NOT EXISTS stats (
                id SERIAL PRIMARY KEY,
                date DATE DEFAULT CURRENT_DATE UNIQUE,
                messages_processed INTEGER DEFAULT 0,
                matches_found INTEGER DEFAULT 0,
                notifications_sent INTEGER DEFAULT 0
            )
        `);

        isInitialized = true;
        console.log('📦 Database initialized');
    } finally {
        client.release();
    }
}

// Helper функции
async function query(sql, params = []) {
    const result = await pool.query(sql, params);
    return result;
}

async function getOne(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows[0] || null;
}

async function getAll(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows;
}

// Экспорт
module.exports = {
    initDatabase,
    pool,
    
    users: {
        create: async (telegramUserId, username, phone, apiId, apiHash, sessionString, botChatId) => {
            const result = await query(`
                INSERT INTO users (telegram_user_id, telegram_username, phone, api_id, api_hash, session_string, bot_chat_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id
            `, [telegramUserId, username, phone, apiId, apiHash, sessionString, botChatId]);
            return { lastInsertRowid: result.rows[0].id, id: result.rows[0].id };
        },
        getByTelegramId: (telegramUserId) => getOne('SELECT * FROM users WHERE telegram_user_id = $1', [telegramUserId]),
        getByPhone: (phone) => getOne('SELECT * FROM users WHERE phone = $1', [phone]),
        getById: (id) => getOne('SELECT * FROM users WHERE id = $1', [id]),
        updateSession: async (id, sessionString) => {
            await query('UPDATE users SET session_string = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [sessionString, id]);
        },
        updateBotChatId: async (telegramUserId, botChatId) => {
            await query('UPDATE users SET bot_chat_id = $1, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = $2', [botChatId, telegramUserId]);
        },
        setActive: async (id, isActive) => {
            await query('UPDATE users SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [isActive, id]);
        },
        getAllActive: () => getAll('SELECT * FROM users WHERE is_active = TRUE'),
        delete: async (id) => await query('DELETE FROM users WHERE id = $1', [id]),
        count: async () => {
            const result = await getOne('SELECT COUNT(*) as count FROM users');
            return parseInt(result?.count || 0);
        },
        countActive: async () => {
            const result = await getOne('SELECT COUNT(*) as count FROM users WHERE is_active = TRUE');
            return parseInt(result?.count || 0);
        }
    },
    
    monitors: {
        create: async (userId, folderName, keywords) => {
            await query(`
                INSERT INTO monitor_settings (user_id, folder_name, keywords, monitoring_started_at)
                VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
            `, [userId, folderName, JSON.stringify(keywords)]);
        },
        getByUserId: async (userId) => {
            const result = await getOne('SELECT * FROM monitor_settings WHERE user_id = $1 AND is_active = TRUE', [userId]);
            if (result) {
                result.keywords = JSON.parse(result.keywords);
            }
            return result;
        },
        update: async (userId, folderName, keywords) => {
            await query('UPDATE monitor_settings SET folder_name = $1, keywords = $2 WHERE user_id = $3', [folderName, JSON.stringify(keywords), userId]);
        },
        setActive: async (userId, isActive) => {
            await query('UPDATE monitor_settings SET is_active = $1 WHERE user_id = $2', [isActive, userId]);
        },
        delete: async (userId) => await query('DELETE FROM monitor_settings WHERE user_id = $1', [userId])
    },
    
    chats: {
        add: async (userId, chatId, chatTitle, chatType) => {
            await query(`
                INSERT INTO monitored_chats (user_id, chat_id, chat_title, chat_type)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (user_id, chat_id) DO UPDATE SET chat_title = $3, chat_type = $4
            `, [userId, chatId, chatTitle, chatType]);
        },
        getByUserId: (userId) => getAll('SELECT * FROM monitored_chats WHERE user_id = $1', [userId]),
        deleteByUserId: async (userId) => await query('DELETE FROM monitored_chats WHERE user_id = $1', [userId]),
        count: async (userId) => {
            const result = await getOne('SELECT COUNT(*) as count FROM monitored_chats WHERE user_id = $1', [userId]);
            return parseInt(result?.count || 0);
        }
    },
    
    notifications: {
        add: async (userId, chatId, messageId) => {
            try {
                await query('INSERT INTO sent_notifications (user_id, chat_id, message_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [userId, chatId, messageId]);
            } catch (e) {}
        },
        exists: async (userId, chatId, messageId) => {
            const result = await getOne('SELECT 1 FROM sent_notifications WHERE user_id = $1 AND chat_id = $2 AND message_id = $3', [userId, chatId, messageId]);
            return !!result;
        },
        cleanup: async () => await query("DELETE FROM sent_notifications WHERE sent_at < NOW() - INTERVAL '7 days'")
    },
    
    auth: {
        create: async (id, phone, apiId, apiHash) => {
            await query(`
                INSERT INTO auth_sessions (id, phone, api_id, api_hash, step, expires_at)
                VALUES ($1, $2, $3, $4, 'phone', NOW() + INTERVAL '30 minutes')
            `, [id, phone, apiId, apiHash]);
        },
        get: (id) => getOne("SELECT * FROM auth_sessions WHERE id = $1 AND expires_at > NOW()", [id]),
        updateStep: async (id, step, phoneCodeHash = null) => {
            await query('UPDATE auth_sessions SET step = $1, phone_code_hash = $2 WHERE id = $3', [step, phoneCodeHash, id]);
        },
        delete: async (id) => await query('DELETE FROM auth_sessions WHERE id = $1', [id]),
        cleanup: async () => await query("DELETE FROM auth_sessions WHERE expires_at < NOW()")
    },
    
    // Новые методы для статистики
    botUsers: {
        upsert: async (telegramUserId, username, firstName, lastName, languageCode) => {
            await query(`
                INSERT INTO bot_users (telegram_user_id, telegram_username, first_name, last_name, language_code)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (telegram_user_id) DO UPDATE SET
                    telegram_username = $2,
                    first_name = $3,
                    last_name = $4,
                    language_code = $5,
                    last_seen = CURRENT_TIMESTAMP
            `, [telegramUserId, username, firstName, lastName, languageCode]);
        },
        count: async () => {
            const result = await getOne('SELECT COUNT(*) as count FROM bot_users');
            return parseInt(result?.count || 0);
        },
        getAll: () => getAll('SELECT * FROM bot_users ORDER BY last_seen DESC')
    },
    
    stats: {
        increment: async (field) => {
            await query(`
                INSERT INTO stats (date, ${field})
                VALUES (CURRENT_DATE, 1)
                ON CONFLICT (date) DO UPDATE SET ${field} = stats.${field} + 1
            `);
        },
        getToday: () => getOne('SELECT * FROM stats WHERE date = CURRENT_DATE'),
        getTotal: async () => {
            const result = await getOne(`
                SELECT 
                    COALESCE(SUM(messages_processed), 0) as messages_processed,
                    COALESCE(SUM(matches_found), 0) as matches_found,
                    COALESCE(SUM(notifications_sent), 0) as notifications_sent
                FROM stats
            `);
            return result;
        }
    }
};
