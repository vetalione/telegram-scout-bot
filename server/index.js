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

// ============ API Routes ============

/**
 * Отправка кода подтверждения
 */
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { apiId, apiHash, phone } = req.body;

        if (!apiId || !apiHash || !phone) {
            return res.status(400).json({ 
                success: false, 
                error: 'Необходимо указать apiId, apiHash и phone' 
            });
        }

        // Создаем сессию авторизации
        const sessionId = uuidv4();
        
        // Создаем клиент для авторизации
        const client = await monitor.createAuthClient(apiId, apiHash);
        
        // Отправляем код
        const result = await monitor.sendCode(client, phone);
        
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
        database.auth.create(sessionId, phone, apiId, apiHash);
        database.auth.updateStep(sessionId, 'code', result.phoneCodeHash);

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
                database.auth.updateStep(sessionId, '2fa', authData.phoneCodeHash);
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

        const authData = authClients.get(sessionId);
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

        const authData = authClients.get(sessionId);
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

        const authData = authClients.get(sessionId);
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
        let user = database.users.getByTelegramId(authData.user.id);
        
        if (user) {
            // Обновляем сессию
            database.users.updateSession(user.id, authData.sessionString);
        } else {
            // Создаем нового пользователя
            const result = database.users.create(
                authData.user.id,
                authData.user.username,
                authData.phone,
                authData.apiId,
                authData.apiHash,
                authData.sessionString,
                null // bot_chat_id будет установлен когда пользователь напишет боту
            );
            user = database.users.getById(result.lastInsertRowid);
        }

        // Удаляем старые настройки мониторинга
        database.monitors.delete(user.id);
        database.chats.deleteByUserId(user.id);

        // Создаем новые настройки
        database.monitors.create(user.id, folderName, keywordsList);

        // Запускаем мониторинг
        const monitorResult = await monitor.startMonitoring(user.id);

        // Очищаем временные данные авторизации
        authClients.delete(sessionId);
        database.auth.delete(sessionId);

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

        const user = database.users.getByTelegramId(userId);
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

        const user = database.users.getByTelegramId(userId);
        if (!user) {
            return res.json({ 
                success: true, 
                isConfigured: false 
            });
        }

        const settings = database.monitors.getByUserId(user.id);
        const chatsCount = database.chats.count(user.id);

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

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Health check для Railway
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Периодическая очистка
setInterval(() => {
    // Очищаем старые auth сессии
    database.auth.cleanup();
    
    // Очищаем старые уведомления
    database.notifications.cleanup();
    
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
app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Bot started`);
    console.log(`🌐 Web interface: http://localhost:${PORT}`);
    
    // Восстанавливаем мониторинг для активных пользователей
    setTimeout(async () => {
        await monitor.restoreAllMonitoring();
    }, 5000);
});

module.exports = app;
