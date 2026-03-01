require('dotenv').config();

const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const database = require('./database');
const NotificationBot = require('./bot');
const TelegramMonitor = require('./monitor');
const { parseKeywords } = require('./keywords');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'client')));

// CORS для локальной разработки
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Инициализация бота и монитора
const bot = new NotificationBot(process.env.BOT_TOKEN);
const monitor = new TelegramMonitor(bot);
bot.setMonitor(monitor);

// Хранилище временных клиентов для авторизации
const authClients = new Map();

/**
 * Восстанавливает сессию авторизации из БД если её нет в памяти
 * Нужно после редеплоя Railway когда память очищается
 */
async function restoreAuthSession(sessionId) {
    // Проверяем, есть ли уже в памяти
    if (authClients.has(sessionId)) {
        return authClients.get(sessionId);
    }
    
    // Пробуем восстановить из БД
    const dbSession = await database.auth.get(sessionId);
    if (!dbSession) {
        return null;
    }
    
    // Если есть user_data и session_string - можно восстановить полностью
    if (dbSession.user_data && dbSession.session_string) {
        console.log(`[Auth] Restoring session ${sessionId} from DB after redeploy`);
        
        // Создаём клиент из сохранённой сессии
        try {
            const client = await monitor.createClientFromSession(
                'temp_restore',
                dbSession.api_id,
                dbSession.api_hash,
                dbSession.session_string
            );
            
            const authData = {
                client,
                phone: dbSession.phone,
                apiId: dbSession.api_id,
                apiHash: dbSession.api_hash,
                phoneCodeHash: dbSession.phone_code_hash,
                user: typeof dbSession.user_data === 'string' 
                    ? JSON.parse(dbSession.user_data) 
                    : dbSession.user_data,
                sessionString: dbSession.session_string,
                createdAt: new Date(dbSession.created_at).getTime(),
                restoredFromDB: true
            };
            
            authClients.set(sessionId, authData);
            console.log(`[Auth] Session ${sessionId} restored successfully`);
            return authData;
        } catch (error) {
            console.error(`[Auth] Failed to restore session ${sessionId}:`, error.message);
            // Удаляем битую сессию из БД
            await database.auth.delete(sessionId);
            return null;
        }
    }
    
    // Сессия есть в БД, но авторизация не была завершена (нет user_data)
    // Нельзя восстановить - клиент Telegram нужен в памяти
    console.log(`[Auth] Session ${sessionId} found in DB but auth was not completed`);
    return null;
}

// ============ API Routes ============

/**
 * Отправка кода подтверждения
 */
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { apiId, apiHash, phone } = req.body;
        
        console.log(`[Auth] Send-code request for phone: ${phone}`);

        if (!apiId || !apiHash || !phone) {
            console.log(`[Auth] Missing fields: apiId=${!!apiId}, apiHash=${!!apiHash}, phone=${!!phone}`);
            return res.status(400).json({ 
                success: false, 
                error: 'Необходимо указать apiId, apiHash и phone' 
            });
        }

        // Создаем сессию авторизации
        const sessionId = uuidv4();
        console.log(`[Auth] Created session ${sessionId} for ${phone}`);
        
        // Создаем клиент для авторизации
        console.log(`[Auth] Creating auth client...`);
        const client = await monitor.createAuthClient(apiId, apiHash);
        console.log(`[Auth] Client created, sending code...`);
        
        // Отправляем код
        const result = await monitor.sendCode(client, phone);
        console.log(`[Auth] SendCode result:`, result.success ? 'success' : result.error);
        
        if (!result.success) {
            await client.disconnect();
            return res.json({ 
                success: false, 
                error: result.error 
            });
        }

        // Сохраняем данные сессии
        authClients.set(sessionId, {
            client,
            phone,
            apiId,
            apiHash,
            phoneCodeHash: result.phoneCodeHash,
            createdAt: Date.now()
        });

        // Сохраняем в БД
        await database.auth.create(sessionId, phone, apiId, apiHash);
        await database.auth.updateStep(sessionId, 'code', result.phoneCodeHash);

        res.json({ 
            success: true, 
            sessionId 
        });

    } catch (error) {
        console.error('Error in send-code:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Подтверждение кода
 */
app.post('/api/auth/verify-code', async (req, res) => {
    try {
        const { sessionId, code } = req.body;

        if (!sessionId || !code) {
            return res.status(400).json({ 
                success: false, 
                error: 'Необходимо указать sessionId и code' 
            });
        }

        const authData = authClients.get(sessionId);
        if (!authData) {
            return res.status(400).json({ 
                success: false, 
                error: 'Сессия истекла. Начните заново.' 
            });
        }

        const result = await monitor.signIn(
            authData.client, 
            authData.phone, 
            code, 
            authData.phoneCodeHash
        );

        if (!result.success) {
            if (result.needPassword) {
                // Обновляем шаг в сессии
                await database.auth.updateStep(sessionId, '2fa', authData.phoneCodeHash);
                return res.json({ 
                    success: false, 
                    needPassword: true,
                    error: result.error 
                });
            }
            return res.json({ 
                success: false, 
                error: result.error 
            });
        }

        // Сохраняем пользователя
        authData.user = result.user;
        authData.sessionString = result.sessionString;

        // Сохраняем в БД для переживания редеплоя
        await database.auth.saveUserData(sessionId, result.user, result.sessionString);

        res.json({ 
            success: true, 
            user: result.user 
        });

    } catch (error) {
        console.error('Error in verify-code:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Подтверждение 2FA пароля
 */
app.post('/api/auth/verify-2fa', async (req, res) => {
    try {
        const { sessionId, password } = req.body;

        if (!sessionId || !password) {
            return res.status(400).json({ 
                success: false, 
                error: 'Необходимо указать sessionId и password' 
            });
        }

        const authData = authClients.get(sessionId);
        if (!authData) {
            return res.status(400).json({ 
                success: false, 
                error: 'Сессия истекла. Начните заново.' 
            });
        }

        const result = await monitor.signInWith2FA(authData.client, password);

        if (!result.success) {
            return res.json({ 
                success: false, 
                error: result.error 
            });
        }

        // Сохраняем пользователя
        authData.user = result.user;
        authData.sessionString = result.sessionString;
        
        // Обновляем в Map
        authClients.set(sessionId, authData);
        
        // Сохраняем в БД для переживания редеплоя
        await database.auth.saveUserData(sessionId, result.user, result.sessionString);
        
        console.log('2FA success, user saved:', authData.user?.id, 'session:', !!authData.sessionString);

        res.json({ 
            success: true, 
            user: result.user 
        });

    } catch (error) {
        console.error('Error in verify-2fa:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Получение списка папок
 */
app.get('/api/folders', async (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Необходимо указать sessionId' 
            });
        }

        // Пробуем получить из памяти или восстановить из БД
        const authData = await restoreAuthSession(sessionId);
        if (!authData || !authData.client) {
            return res.status(400).json({ 
                success: false, 
                error: 'Сессия истекла. Начните заново.' 
            });
        }

        const folders = await monitor.getFolders(authData.client);

        res.json({ 
            success: true, 
            folders 
        });

    } catch (error) {
        console.error('Error in get folders:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Получение чатов из папки
 */
app.get('/api/folders/:folderName/chats', async (req, res) => {
    try {
        const { folderName } = req.params;
        const { sessionId } = req.query;

        if (!sessionId || !folderName) {
            return res.status(400).json({ 
                success: false, 
                error: 'Необходимо указать sessionId и folderName' 
            });
        }

        // Пробуем получить из памяти или восстановить из БД
        const authData = await restoreAuthSession(sessionId);
        if (!authData || !authData.client) {
            return res.status(400).json({ 
                success: false, 
                error: 'Сессия истекла. Начните заново.' 
            });
        }

        const result = await monitor.getChatsFromFolder(authData.client, folderName);

        if (!result.success) {
            return res.json({ 
                success: false, 
                error: result.error 
            });
        }

        res.json({ 
            success: true, 
            chats: result.chats,
            unavailableChats: result.unavailableChats || [],
            total: result.total,
            maxAllowed: result.maxAllowed
        });

    } catch (error) {
        console.error('Error in get chats:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Запуск мониторинга
 */
app.post('/api/monitoring/start', async (req, res) => {
    try {
        const { sessionId, folderName, keywords } = req.body;

        if (!sessionId || !folderName || !keywords) {
            return res.status(400).json({ 
                success: false, 
                error: 'Необходимо указать sessionId, folderName и keywords' 
            });
        }

        // Пробуем получить из памяти или восстановить из БД
        const authData = await restoreAuthSession(sessionId);
        if (!authData || !authData.user || !authData.sessionString) {
            console.log('Auth check failed:', {
                hasAuthData: !!authData,
                hasUser: !!authData?.user,
                hasSession: !!authData?.sessionString
            });
            return res.status(400).json({ 
                success: false, 
                error: 'Сессия истекла или авторизация не завершена' 
            });
        }

        // Парсим ключевые слова
        const keywordsList = parseKeywords(keywords);
        if (keywordsList.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Необходимо указать хотя бы одно ключевое слово' 
            });
        }

        // Проверяем, есть ли уже пользователь в системе
        let user = await database.users.getByTelegramId(authData.user.id);
        
        if (user) {
            // Обновляем сессию
            await database.users.updateSession(user.id, authData.sessionString);
        } else {
            // Создаем нового пользователя
            await database.users.create(
                authData.user.id,
                authData.user.username,
                authData.phone,
                authData.apiId,
                authData.apiHash,
                authData.sessionString,
                null // bot_chat_id будет установлен когда пользователь напишет боту
            );
            // Получаем созданного пользователя по telegram_user_id
            user = await database.users.getByTelegramId(authData.user.id);
        }
        
        if (!user) {
            return res.status(500).json({ 
                success: false, 
                error: 'Ошибка создания пользователя в базе данных' 
            });
        }

        // Удаляем старые настройки мониторинга
        await database.monitors.delete(user.id);
        await database.chats.deleteByUserId(user.id);

        // Создаем новые настройки
        await database.monitors.create(user.id, folderName, keywordsList);

        // Запускаем мониторинг
        const monitorResult = await monitor.startMonitoring(user.id);

        // Очищаем временные данные авторизации
        authClients.delete(sessionId);
        await database.auth.delete(sessionId);

        if (!monitorResult.success) {
            return res.json({ 
                success: false, 
                error: monitorResult.error 
            });
        }

        res.json({ 
            success: true, 
            chatsCount: monitorResult.chatsCount,
            message: 'Мониторинг успешно запущен!'
        });

    } catch (error) {
        console.error('Error in start monitoring:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Остановка мониторинга
 */
app.post('/api/monitoring/stop', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Необходимо указать userId' 
            });
        }

        const user = await database.users.getByTelegramId(userId);
        if (!user) {
            return res.status(404).json({ 
                success: false, 
                error: 'Пользователь не найден' 
            });
        }

        const result = await monitor.stopMonitoring(user.id);

        res.json(result);

    } catch (error) {
        console.error('Error in stop monitoring:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Статус мониторинга
 */
app.get('/api/monitoring/status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const user = await database.users.getByTelegramId(userId);
        if (!user) {
            return res.json({ 
                success: true, 
                isConfigured: false 
            });
        }

        const settings = await database.monitors.getByUserId(user.id);
        const chatsCount = await database.chats.count(user.id);

        res.json({ 
            success: true,
            isConfigured: true,
            isActive: !!user.is_active,
            folderName: settings?.folder_name,
            keywords: settings?.keywords,
            chatsCount
        });

    } catch (error) {
        console.error('Error in get status:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Диагностика сессии пользователя
 */
app.get('/api/diagnose/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const dbUserId = parseInt(userId);

        if (isNaN(dbUserId)) {
            return res.status(400).json({ success: false, error: 'Invalid userId' });
        }

        const result = await monitor.diagnoseSession(dbUserId);
        res.json(result);

    } catch (error) {
        console.error('Error in diagnose:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Health check для Railway
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Периодическая очистка
setInterval(async () => {
    try {
        // Очищаем старые auth сессии
        await database.auth.cleanup();
        
        // Очищаем старые уведомления
        await database.notifications.cleanup();
        
        // Очищаем хеши сообщений старше 24 часов (без этого таблица росла бесконечно)
        await database.messageHashes.cleanup();
        
        // Очищаем просроченные клиенты авторизации (старше 30 минут)
        const now = Date.now();
        for (const [sessionId, data] of authClients) {
            if (now - data.createdAt > 30 * 60 * 1000) {
                if (data.client) {
                    data.client.disconnect().catch(() => {});
                }
                authClients.delete(sessionId);
            }
        }

        // Логируем использование памяти для мониторинга утечек
        const mem = process.memoryUsage();
        console.log(`[Memory] RSS: ${Math.round(mem.rss / 1024 / 1024)}MB, Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB, External: ${Math.round(mem.external / 1024 / 1024)}MB`);
    } catch (e) {
        console.error('Cleanup error:', e);
    }
}, 5 * 60 * 1000); // каждые 5 минут

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    await monitor.shutdown();
    bot.stop();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully...');
    await monitor.shutdown();
    bot.stop();
    process.exit(0);
});

// Запуск сервера
async function startServer() {
    // Инициализируем базу данных
    await database.initDatabase();
    console.log('📦 Database initialized');
    
    app.listen(PORT, async () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📱 Bot started`);
        console.log(`🌐 Web interface: http://localhost:${PORT}`);
        
        // Восстанавливаем мониторинг для активных пользователей
        setTimeout(async () => {
            await monitor.restoreAllMonitoring();
        }, 5000);
    });
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

module.exports = app;
