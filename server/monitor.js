const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage, Raw } = require('telegram/events');
const { computeCheck } = require('telegram/Password');
const crypto = require('crypto');
const database = require('./database');
const { KeywordMatcher, formatNotification } = require('./keywords');

const MAX_CHATS_PER_USER = 50;
const FLOOD_WAIT_MULTIPLIER = 1.5;

// Создание хеша текста сообщения для дедупликации
function createMessageHash(text) {
    // Нормализуем текст: lowercase, убираем пробелы по краям
    const normalized = text.toLowerCase().trim();
    return crypto.createHash('md5').update(normalized).digest('hex');
}

class TelegramMonitor {
    constructor(bot) {
        this.bot = bot; // Telegram бот для отправки уведомлений
        this.clients = new Map(); // userId -> TelegramClient
        this.keywordMatcher = new KeywordMatcher();
        this.isRunning = false;
    }

    /**
     * Создает клиент для авторизации (без сохраненной сессии)
     */
    async createAuthClient(apiId, apiHash) {
        const client = new TelegramClient(
            new StringSession(''),
            parseInt(apiId),
            apiHash,
            {
                connectionRetries: 5,
                useWSS: false,
                deviceModel: 'Scout Bot',
                systemVersion: 'Node.js',
                appVersion: '1.0.0',
                langCode: 'ru'
            }
        );
        
        await client.connect();
        return client;
    }

    /**
     * Начинает процесс авторизации - отправляет код
     */
    async sendCode(client, phone) {
        try {
            console.log(`[Monitor] Sending code to ${phone}...`);
            const result = await client.invoke(
                new Api.auth.SendCode({
                    phoneNumber: phone,
                    apiId: client.apiId,
                    apiHash: client.apiHash,
                    settings: new Api.CodeSettings({})
                })
            );
            console.log(`[Monitor] Code sent successfully to ${phone}, type: ${result.type?.className}`);
            return {
                success: true,
                phoneCodeHash: result.phoneCodeHash
            };
        } catch (error) {
            console.error(`[Monitor] Error sending code to ${phone}:`, error.message);
            
            if (error.message.includes('FLOOD_WAIT')) {
                const waitTime = parseInt(error.message.match(/\d+/)?.[0] || 60);
                console.error(`[Monitor] FLOOD_WAIT: ${waitTime} seconds`);
                return {
                    success: false,
                    error: `Слишком много попыток. Подождите ${waitTime} секунд.`
                };
            }
            
            if (error.message.includes('PHONE_NUMBER_INVALID')) {
                return {
                    success: false,
                    error: 'Неверный формат номера телефона. Используйте международный формат: +79991234567'
                };
            }
            
            if (error.message.includes('API_ID_INVALID')) {
                return {
                    success: false,
                    error: 'Неверный API ID. Проверьте данные на my.telegram.org'
                };
            }
            
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Подтверждает код авторизации
     */
    async signIn(client, phone, code, phoneCodeHash) {
        try {
            await client.invoke(
                new Api.auth.SignIn({
                    phoneNumber: phone,
                    phoneCodeHash: phoneCodeHash,
                    phoneCode: code
                })
            );
            
            // Получаем информацию о пользователе
            const me = await client.getMe();
            const sessionString = client.session.save();
            
            return {
                success: true,
                user: {
                    id: me.id.toString(),
                    firstName: me.firstName,
                    lastName: me.lastName,
                    username: me.username,
                    phone: me.phone
                },
                sessionString
            };
        } catch (error) {
            console.error('Error signing in:', error);
            
            if (error.message.includes('SESSION_PASSWORD_NEEDED')) {
                return {
                    success: false,
                    needPassword: true,
                    error: 'Требуется пароль двухфакторной аутентификации'
                };
            }
            
            if (error.message.includes('PHONE_CODE_INVALID')) {
                return {
                    success: false,
                    error: 'Неверный код подтверждения'
                };
            }
            
            if (error.message.includes('PHONE_CODE_EXPIRED')) {
                return {
                    success: false,
                    error: 'Код подтверждения истек. Запросите новый.'
                };
            }
            
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Подтверждает пароль 2FA
     */
    async signInWith2FA(client, password) {
        try {
            const passwordInfo = await client.invoke(new Api.account.GetPassword());
            
            const result = await client.invoke(
                new Api.auth.CheckPassword({
                    password: await computeCheck(passwordInfo, password)
                })
            );
            
            const me = await client.getMe();
            const sessionString = client.session.save();
            
            return {
                success: true,
                user: {
                    id: me.id.toString(),
                    firstName: me.firstName,
                    lastName: me.lastName,
                    username: me.username,
                    phone: me.phone
                },
                sessionString
            };
        } catch (error) {
            console.error('Error with 2FA:', error);
            
            if (error.message.includes('PASSWORD_HASH_INVALID')) {
                return {
                    success: false,
                    error: 'Неверный пароль'
                };
            }
            
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Получает список папок пользователя
     */
    async getFolders(client) {
        try {
            const result = await client.invoke(new Api.messages.GetDialogFilters());
            
            const folders = [];
            const filters = result.filters || result;
            
            for (const filter of filters) {
                // Пропускаем системные фильтры (DialogFilterDefault и т.п.)
                if (!filter.title) continue;
                
                // title может быть строкой или объектом
                let title;
                if (typeof filter.title === 'string') {
                    title = filter.title;
                } else if (filter.title && typeof filter.title === 'object') {
                    // Может быть { text: "название" } или просто объект со свойством
                    title = filter.title.text || filter.title.toString() || String(filter.title);
                } else {
                    continue;
                }
                
                // Фильтруем только реальные папки с названием
                if (title && title !== '[object Object]') {
                    // Показываем общее количество диалогов в папке
                    const peersCount = (filter.includePeers || []).length;
                    
                    folders.push({
                        id: filter.id,
                        title: title,
                        includePeers: peersCount,
                        excludePeers: filter.excludePeers?.length || 0
                    });
                }
            }
            
            return folders;
        } catch (error) {
            console.error('Error getting folders:', error);
            return [];
        }
    }

    /**
     * Получает чаты из указанной папки
     */
    async getChatsFromFolder(client, folderName) {
        try {
            const result = await client.invoke(new Api.messages.GetDialogFilters());
            
            let targetFilter = null;
            for (const filter of result.filters || result) {
                if (!filter.title) continue;
                
                // Извлекаем title как строку
                let title;
                if (typeof filter.title === 'string') {
                    title = filter.title;
                } else if (filter.title && typeof filter.title === 'object') {
                    title = filter.title.text || String(filter.title);
                } else {
                    continue;
                }
                
                if (title.toLowerCase() === folderName.toLowerCase()) {
                    targetFilter = filter;
                    break;
                }
            }
            
            if (!targetFilter) {
                return { success: false, error: `Папка "${folderName}" не найдена` };
            }

            const chats = [];
            const unavailableChats = [];
            const includePeers = targetFilter.includePeers || [];
            
            // Получаем информацию о каждом чате
            for (const peer of includePeers.slice(0, MAX_CHATS_PER_USER)) {
                try {
                    let chatId, chatType;
                    
                    if (peer.className === 'InputPeerChannel' || peer.channelId) {
                        chatId = peer.channelId?.toString() || peer.channel_id?.toString();
                        chatType = 'channel';
                    } else if (peer.className === 'InputPeerChat' || peer.chatId) {
                        chatId = peer.chatId?.toString() || peer.chat_id?.toString();
                        chatType = 'group';
                    } else if (peer.className === 'InputPeerUser' || peer.userId) {
                        // Пропускаем личные чаты
                        continue;
                    } else {
                        continue;
                    }

                    // Получаем информацию о чате
                    let entity;
                    try {
                        entity = await client.getEntity(peer);
                    } catch (e) {
                        console.log(`Could not get entity for peer:`, e.message);
                        // Добавляем в список недоступных
                        unavailableChats.push({
                            id: chatId,
                            reason: e.message.includes('CHANNEL_PRIVATE') ? 'Приватный/недоступный канал' : e.message
                        });
                        continue;
                    }

                    // Пропускаем личные чаты и каналы без комментариев
                    if (entity.className === 'User') {
                        continue;
                    }

                    const isGroup = entity.className === 'Chat' || 
                                   entity.className === 'Channel' && entity.megagroup;
                    
                    if (!isGroup) {
                        // Это канал без комментариев - пропускаем
                        continue;
                    }

                    chats.push({
                        id: entity.id.toString(),
                        title: entity.title || 'Без названия',
                        type: entity.megagroup ? 'supergroup' : 'group',
                        username: entity.username || null,
                        available: true
                    });

                } catch (error) {
                    console.error('Error processing peer:', error.message);
                }
            }

            return { 
                success: true, 
                chats,
                unavailableChats,
                total: chats.length,
                maxAllowed: MAX_CHATS_PER_USER
            };

        } catch (error) {
            console.error('Error getting chats from folder:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Создает клиент из сохраненной сессии
     */
    async createClientFromSession(userId, apiId, apiHash, sessionString) {
        try {
            console.log(`[Monitor] Creating client for user ${userId} from session...`);
            
            const client = new TelegramClient(
                new StringSession(sessionString),
                parseInt(apiId),
                apiHash,
                {
                    connectionRetries: 10,
                    retryDelay: 2000,
                    timeout: 30,
                    useWSS: true,
                    // Уникальные параметры для каждого клиента
                    deviceModel: `ScoutBot-User${userId}`,
                    systemVersion: 'Node.js',
                    appVersion: `1.0.${userId}`,
                    langCode: 'en',
                    // Ограничиваем кэш сущностей gramjs чтобы предотвратить утечку RAM:
                    // без лимита кэш растёт бесконечно (тысячи users/chats из 50 чатов)
                    maxConcurrentDownloads: 1
                }
            );
            
            await client.connect();
            console.log(`[Monitor] Client ${userId} connected`);
            
            // Проверяем авторизацию
            try {
                const state = await client.invoke(new Api.updates.GetState());
                console.log(`[Monitor] Client ${userId} authorized (pts=${state.pts})`);
            } catch (authError) {
                console.error(`[Monitor] Client ${userId} authorization check failed:`, authError.message);
                if (authError.message.includes('AUTH_KEY_UNREGISTERED') || 
                    authError.message.includes('SESSION_REVOKED') ||
                    authError.message.includes('USER_DEACTIVATED')) {
                    throw new Error(`Session for user ${userId} is invalid, needs re-authorization`);
                }
                throw authError;
            }
            
            this.clients.set(userId, client);

            // В gramjs 2.26.x connected=true && disconnected=true одновременно:
            // TCP-соединение живое, но _sender.userDisconnected=true блокирует update loop.
            // Сбрасываем флаг напрямую, чтобы события начали диспатчиться.
            if (client._sender && client._sender.userDisconnected) {
                console.log(`[Monitor] Resetting userDisconnected flag for user ${userId}`);
                client._sender.userDisconnected = false;
            }

            // Raw-хук для диагностики: показывает ВСЕ типы апдейтов от Telegram
            // Если в логах не видно [RAW] — gramjs не получает никаких данных
            if (!client._rawDebugHandler) {
                client._rawDebugHandler = (update) => {
                    console.log(`[Monitor] [RAW] user ${userId} update: ${update.className}`);
                };
                client.addEventHandler(client._rawDebugHandler, new Raw({}));
            }

            // Periodic health check to detect stuck update loops (TIMEOUTs)
            // If we detect repeated failures, restart the client with backoff
            let consecutiveFailures = 0;
            const maxFailuresBeforeRestart = 3;
            const baseDelayMs = 2000; // exponential backoff base

            const healthCheck = async () => {
                try {
                    // Quick check to ensure updates loop is alive
                    await client.invoke(new Api.updates.GetState());
                    if (consecutiveFailures > 0) {
                        console.log(`[Monitor] Health OK for user ${userId}, resetting failure count`);
                    }
                    consecutiveFailures = 0;
                } catch (err) {
                    consecutiveFailures++;
                    console.warn(`[Monitor] Health check failed for user ${userId} (attempt ${consecutiveFailures}):`, err.message);

                    if (consecutiveFailures >= maxFailuresBeforeRestart) {
                        const delay = baseDelayMs * Math.pow(2, Math.min(consecutiveFailures - maxFailuresBeforeRestart, 6));
                        console.warn(`[Monitor] Restarting client for user ${userId} after ${delay}ms due to repeated health failures`);

                        try {
                            await client.disconnect();
                        } catch (e) {
                            console.error(`[Monitor] Error while disconnecting client ${userId}:`, e.message);
                        }

                        // remove from map to signal recreation is needed
                        this.clients.delete(userId);

                        // Wait then try to recreate via startMonitoring (it handles client creation internally)
                        setTimeout(async () => {
                            try {
                                console.log(`[Monitor] Restarting monitoring for user ${userId} after health restart`);
                                await this.startMonitoring(userId);
                            } catch (startErr) {
                                console.error(`[Monitor] Failed to restart monitoring for user ${userId}:`, startErr.message);
                            }
                        }, delay);
                    }
                }
            };

            // run health checks every 5 minutes (снижает egress и нагрузку)
            client._healthInterval = setInterval(healthCheck, 5 * 60 * 1000);

            // ensure interval is cleared on disconnect
            const origDisconnect = client.disconnect.bind(client);
            client.disconnect = async (...args) => {
                if (client._healthInterval) {
                    clearInterval(client._healthInterval);
                    client._healthInterval = null;
                }
                try {
                    return await origDisconnect(...args);
                } catch (e) {
                    throw e;
                }
            };

            return client;
        } catch (error) {
            console.error(`[Monitor] Error creating client for user ${userId}:`, error.message);
            throw error;
        }
    }

    /**
     * Запускает мониторинг для пользователя
     */
    async startMonitoring(userId) {
        try {
            const user = await database.users.getById(userId);
            if (!user) {
                throw new Error('User not found');
            }

            // Реактивируем настройки мониторинга на случай если они были деактивированы через stopMonitoring.
            // getByUserId фильтрует по is_active = TRUE, поэтому нужно сбросить флаг перед чтением.
            await database.monitors.setActive(userId, true);

            const settings = await database.monitors.getByUserId(userId);
            if (!settings) {
                throw new Error('Monitor settings not found');
            }

            // Создаем клиент если его еще нет или если TCP-соединение не активно.
            // ВАЖНО: используем !client.connected, а не client.disconnected —
            // в gramjs 2.26.x disconnected=true даже при живом TCP-соединении (userDisconnected
            // не сбрасывается корректно), что ранее вызывало бесконечное пересоздание клиентов.
            let client = this.clients.get(userId);
            if (!client || !client.connected) {
                if (client) {
                    console.log(`[Monitor] Existing client for user ${userId} is not connected, recreating...`);
                    this.clients.delete(userId);
                }
                client = await this.createClientFromSession(
                    userId,
                    user.api_id,
                    user.api_hash,
                    user.session_string
                );
            }

            // Получаем чаты из папки
            const chatsResult = await this.getChatsFromFolder(client, settings.folder_name);
            if (!chatsResult.success) {
                throw new Error(chatsResult.error);
            }

            // Сохраняем чаты в БД
            await database.chats.deleteByUserId(userId);
            for (const chat of chatsResult.chats) {
                await database.chats.add(userId, chat.id, chat.title, chat.type);
            }

            // Множество отслеживаемых chatId (сырые, без -100) для быстрой проверки в handler'е
            const monitoredChatIds = new Set(chatsResult.chats.map(c => c.id.toString()));

            console.log(`Starting monitoring for user ${userId}, ${monitoredChatIds.size} chats`);
            console.log(`Chat IDs to monitor:`, Array.from(monitoredChatIds));
            console.log(`Keywords for user ${userId}:`, settings.keywords);

            // Удаляем старый обработчик если он есть — предотвращает накопление handler'ов
            if (client._scoutHandler) {
                client.removeEventHandler(client._scoutHandler, new NewMessage({}));
                client._scoutHandler = null;
                console.log(`[Monitor] Removed old event handler for user ${userId}`);
            }

            // Устанавливаем обработчик новых сообщений.
            // ВАЖНО: НЕ передаём chats в NewMessage — gramjs сравнивает по внутреннему
            // channelId (сырой, без -100), а Bot API формат (-100xxxxxxxx) не совпадает.
            // Вместо этого фильтруем вручную по monitoredChatIds внутри handleNewMessage.
            const handler = async (event) => {
                await this.handleNewMessage(event, userId, user, settings, monitoredChatIds);
            };

            client.addEventHandler(handler, new NewMessage({}));

            // Сохраняем обработчик для возможности отключения
            client._scoutHandler = handler;
            
            // Проверяем состояние клиента и количество handlers
            const handlers = client.listEventHandlers();
            console.log(`[Monitor] Client for user ${userId} connected: ${client.connected}, disconnected: ${client.disconnected}`);
            console.log(`[Monitor] Client ${userId} has ${handlers.length} event handlers`);
            console.log(`[Monitor] Total clients in Map: ${this.clients.size}, keys: [${Array.from(this.clients.keys()).join(', ')}]`);

            // Активируем пользователя
            await database.users.setActive(userId, true);

            return {
                success: true,
                chatsCount: chatsResult.chats.length
            };

        } catch (error) {
            console.error(`Error starting monitoring for user ${userId}:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Обработчик новых сообщений
     */
    async handleNewMessage(event, userId, userSnapshot, settingsSnapshot, monitoredChatIds) {
        try {
            const message = event.message;

            // Фильтруем по чатам вручную (вместо gramjs-фильтра chats:[...] который
            // некорректно сравнивает Bot API -100xxxxxxxx формат с внутренним channelId)
            const rawChatId = message.peerId?.channelId?.toString() ||
                              message.peerId?.chatId?.toString() ||
                              message.chatId?.toString();

            if (!rawChatId) return;

            // DEBUG: логируем каждое входящее сообщение ДО фильтра
            const msgPreviewRaw = message.message?.substring(0, 80) || '[no text]';
            console.log(`[Monitor] RAW event user ${userId}: chatId=${rawChatId}, monitored=${monitoredChatIds ? monitoredChatIds.has(rawChatId) : 'no-filter'}, text="${msgPreviewRaw}"`);

            if (monitoredChatIds && !monitoredChatIds.has(rawChatId)) {
                // Сообщение из не отслеживаемого чата — пропускаем
                return;
            }

            const msgPreview = message.message?.substring(0, 100) || '[empty]';
            console.log(`[Monitor] New message for user ${userId} in chat ${rawChatId}: "${msgPreview}"`);
            
            // Считаем обработанное сообщение
            await database.stats.increment('messages_processed');
            
            // Пропускаем сервисные сообщения
            if (!message.message || message.message.length === 0) {
                console.log(`[Monitor] Skipping: empty message`);
                return;
            }
            
            // ВАЖНО: Загружаем свежие данные пользователя из БД
            // чтобы получить актуальный bot_chat_id (мог обновиться после /start)
            const user = await database.users.getById(userId);
            if (!user) {
                console.log(`[Monitor] User ${userId} not found in DB`);
                return;
            }

            // ВАЖНО: Загружаем свежие настройки мониторинга из БД
            // чтобы получить актуальные ключевые слова (могли обновиться через веб-форму)
            const settings = await database.monitors.getByUserId(userId);
            if (!settings) {
                console.log(`[Monitor] Settings for user ${userId} not found in DB`);
                return;
            }

            // Проверяем на соответствие ключевым словам
            const keywords = settings.keywords;
            console.log(`[Monitor] Keywords to check:`, JSON.stringify(keywords));
            console.log(`[Monitor] Message text: "${message.message}"`);
            
            const matchResult = this.keywordMatcher.analyze(message.message, {
                keywords: keywords
            });

            console.log(`[Monitor] Match result: matched=${matchResult.matched}, keywords=${JSON.stringify(matchResult.matchedKeywords)}`);
            console.log(`[Monitor] Match details:`, JSON.stringify(matchResult.matchDetails, null, 2));

            if (!matchResult.matched) {
                console.log(`[Monitor] No keyword match, skipping`);
                return;
            }
            
            console.log(`[Monitor] ✓ Match found! Sending notification...`);
            
            // Считаем найденное совпадение
            await database.stats.increment('matches_found');

            // Проверяем, не отправляли ли мы уже это уведомление (используем rawChatId из начала функции)
            const chatId = rawChatId;
            const messageId = message.id.toString();

            if (await database.notifications.exists(userId, chatId, messageId)) {
                return;
            }

            // Получаем информацию об отправителе
            let sender;
            try {
                sender = await message.getSender();
            } catch (e) {
                sender = { id: 'unknown', firstName: 'Неизвестно' };
            }

            const senderId = sender.id?.toString() || 'unknown';

            // Проверяем, не заблокирован ли автор
            if (senderId !== 'unknown' && await database.blockedAuthors.exists(userId, senderId)) {
                console.log(`[Monitor] Skipping: author ${senderId} is blocked by user ${userId}`);
                return;
            }

            // Проверяем на дубликат сообщения (по хешу текста за 24 часа)
            const messageHash = createMessageHash(message.message);
            if (await database.messageHashes.exists(userId, messageHash)) {
                console.log(`[Monitor] Skipping: duplicate message (hash: ${messageHash.substring(0, 8)}...)`);
                return;
            }

            // Получаем информацию о чате
            let chat;
            try {
                chat = await message.getChat();
            } catch (e) {
                chat = { title: 'Неизвестный чат' };
            }

            // Форматируем и отправляем уведомление
            const notification = formatNotification({
                firstName: sender.firstName || 'Неизвестно',
                username: sender.username,
                userId: senderId,
                messageText: message.message,
                chatTitle: chat.title || 'Неизвестный чат',
                chatId: chatId,
                messageId: messageId,
                matchedKeywords: matchResult.matchedKeywords,
                matchDetails: matchResult.matchDetails || []
            });

            // Кнопки для уведомления
            const inlineKeyboard = {
                inline_keyboard: []
            };
            
            // Добавляем кнопки только если известен ID автора
            if (senderId !== 'unknown') {
                const authorName = sender.firstName || sender.username || 'автора';
                
                // Кнопка "Написать автору" - открывает диалог напрямую
                inlineKeyboard.inline_keyboard.push([
                    {
                        text: '💬 Написать автору',
                        url: `tg://user?id=${senderId}`
                    }
                ]);
                
                // Кнопка "Заблокировать автора"
                inlineKeyboard.inline_keyboard.push([
                    {
                        text: '🚷 Заблокировать автора',
                        callback_data: `block_author:${senderId}:${authorName.substring(0, 30)}`
                    }
                ]);
            }

            // Отправляем уведомление через бота
            console.log(`[Monitor] User bot_chat_id: ${user.bot_chat_id}`);
            if (user.bot_chat_id) {
                try {
                    const messageOptions = {
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true
                    };
                    
                    // Добавляем кнопки только если они есть
                    if (inlineKeyboard.inline_keyboard.length > 0) {
                        messageOptions.reply_markup = inlineKeyboard;
                    }
                    
                    await this.bot.sendMessage(user.bot_chat_id, notification, messageOptions);
                    console.log(`[Monitor] ✓ Notification sent to ${user.bot_chat_id}`);

                    // Сохраняем информацию об отправленном уведомлении
                    await database.notifications.add(userId, chatId, messageId);
                    
                    // Сохраняем хеш сообщения для дедупликации
                    await database.messageHashes.add(userId, messageHash);
                    
                    // Считаем отправленное уведомление
                    await database.stats.increment('notifications_sent');
                } catch (sendError) {
                    console.error(`[Monitor] Failed to send notification:`, sendError.message);
                    
                    // Если ошибка связана с кнопками (BUTTON_USER_INVALID), пробуем без кнопок
                    if (sendError.message.includes('BUTTON_USER_INVALID') || 
                        sendError.message.includes('BUTTON_URL_INVALID')) {
                        try {
                            console.log(`[Monitor] Retrying without user button...`);
                            
                            // Убираем кнопку "Написать автору", оставляем только "Заблокировать"
                            const fallbackKeyboard = {
                                inline_keyboard: inlineKeyboard.inline_keyboard.filter(
                                    row => !row.some(btn => btn.url?.startsWith('tg://user'))
                                )
                            };
                            
                            const fallbackOptions = {
                                parse_mode: 'Markdown',
                                disable_web_page_preview: true
                            };
                            
                            if (fallbackKeyboard.inline_keyboard.length > 0) {
                                fallbackOptions.reply_markup = fallbackKeyboard;
                            }
                            
                            await this.bot.sendMessage(user.bot_chat_id, notification, fallbackOptions);
                            console.log(`[Monitor] ✓ Notification sent (without user button)`);
                            
                            await database.notifications.add(userId, chatId, messageId);
                            await database.messageHashes.add(userId, messageHash);
                            await database.stats.increment('notifications_sent');
                        } catch (retryError) {
                            console.error(`[Monitor] Retry also failed:`, retryError.message);
                        }
                    }
                }
            } else {
                console.log(`[Monitor] ⚠ No bot_chat_id for user ${userId}, cannot send notification`);
            }

        } catch (error) {
            console.error('Error handling message:', error);
        }
    }

    /**
     * Останавливает мониторинг для пользователя
     */
    async stopMonitoring(userId) {
        try {
            const client = this.clients.get(userId);
            if (client) {
                if (client._scoutHandler) {
                    client.removeEventHandler(client._scoutHandler, new NewMessage({}));
                }
                await client.disconnect();
                this.clients.delete(userId);
            }

            await database.users.setActive(userId, false);
            await database.monitors.setActive(userId, false);

            return { success: true };
        } catch (error) {
            console.error(`Error stopping monitoring for user ${userId}:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Восстанавливает мониторинг для всех активных пользователей
     */
    async restoreAllMonitoring() {
        console.log('Restoring monitoring for active users...');
        
        const activeUsers = await database.users.getAllActive();
        console.log(`Found ${activeUsers.length} active users in database:`, 
            activeUsers.map(u => ({ id: u.id, phone: u.phone, hasSession: !!u.session_string })));
        
        // Сортируем по ID чтобы порядок был предсказуемым
        activeUsers.sort((a, b) => a.id - b.id);
        
        for (const user of activeUsers) {
            try {
                await this.startMonitoring(user.id);
                console.log(`Restored monitoring for user ${user.id}`);
                
                // Увеличиваем задержку между подключениями до 5 секунд
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (error) {
                console.error(`Failed to restore monitoring for user ${user.id}:`, error);
            }
        }
        
        console.log(`Restored monitoring for ${activeUsers.length} users`);
    }

    /**
     * Останавливает все подключения
     */
    async shutdown() {
        console.log('Shutting down all connections...');
        
        for (const [userId, client] of this.clients) {
            try {
                await client.disconnect();
            } catch (error) {
                console.error(`Error disconnecting user ${userId}:`, error);
            }
        }
        
        this.clients.clear();
    }

    /**
     * Диагностика сессии пользователя
     */
    async diagnoseSession(userId) {
        try {
            const user = await database.users.getById(userId);
            if (!user) {
                return { success: false, error: 'User not found' };
            }

            if (!user.session_string) {
                return { success: false, error: 'No session string saved' };
            }

            console.log(`[Diagnose] Testing session for user ${userId}...`);

            // Создаём тестовый клиент
            const client = new TelegramClient(
                new StringSession(user.session_string),
                parseInt(user.api_id),
                user.api_hash,
                {
                    connectionRetries: 3,
                    useWSS: false,
                    deviceModel: 'Diagnose Tool',
                    systemVersion: 'Node.js',
                    appVersion: '1.0.0'
                }
            );

            await client.connect();
            console.log(`[Diagnose] Connected`);

            // Проверяем авторизацию
            const me = await client.getMe();
            console.log(`[Diagnose] Authorized as: ${me.firstName} ${me.lastName || ''} (@${me.username || 'no username'})`);

            // Получаем состояние updates
            const state = await client.invoke(new Api.updates.GetState());
            console.log(`[Diagnose] Updates state: pts=${state.pts}, qts=${state.qts}, seq=${state.seq}`);

            // Получаем диалоги
            const dialogs = await client.getDialogs({ limit: 10 });
            console.log(`[Diagnose] Got ${dialogs.length} dialogs`);

            // Проверяем настройки мониторинга
            const settings = await database.monitors.getByUserId(userId);
            let folderCheck = null;
            if (settings && settings.folder_name) {
                const foldersResult = await this.getChatsFromFolder(client, settings.folder_name);
                if (foldersResult.success) {
                    folderCheck = {
                        folderName: settings.folder_name,
                        chatsCount: foldersResult.chats.length,
                        chats: foldersResult.chats.slice(0, 5).map(c => ({ id: c.id, title: c.title }))
                    };
                    console.log(`[Diagnose] Folder "${settings.folder_name}" has ${foldersResult.chats.length} chats`);
                } else {
                    folderCheck = { folderName: settings.folder_name, error: foldersResult.error };
                    console.log(`[Diagnose] Folder error: ${foldersResult.error}`);
                }
            }

            // Закрываем тестовый клиент
            await client.disconnect();

            return {
                success: true,
                user: {
                    id: me.id.toString(),
                    firstName: me.firstName,
                    lastName: me.lastName,
                    username: me.username,
                    phone: me.phone
                },
                state: {
                    pts: state.pts,
                    qts: state.qts,
                    seq: state.seq
                },
                dialogsCount: dialogs.length,
                folderCheck
            };

        } catch (error) {
            console.error(`[Diagnose] Error:`, error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = TelegramMonitor;
