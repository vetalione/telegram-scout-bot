const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { computeCheck } = require('telegram/Password');
const database = require('./database');
const { KeywordMatcher, formatNotification } = require('./keywords');

const MAX_CHATS_PER_USER = 50;
const FLOOD_WAIT_MULTIPLIER = 1.5;

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
            const result = await client.invoke(
                new Api.auth.SendCode({
                    phoneNumber: phone,
                    apiId: client.apiId,
                    apiHash: client.apiHash,
                    settings: new Api.CodeSettings({})
                })
            );
            return {
                success: true,
                phoneCodeHash: result.phoneCodeHash
            };
        } catch (error) {
            console.error('Error sending code:', error);
            
            if (error.message.includes('FLOOD_WAIT')) {
                const waitTime = parseInt(error.message.match(/\d+/)?.[0] || 60);
                return {
                    success: false,
                    error: `Слишком много попыток. Подождите ${waitTime} секунд.`
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
            const client = new TelegramClient(
                new StringSession(sessionString),
                parseInt(apiId),
                apiHash,
                {
                    connectionRetries: 5,
                    useWSS: false
                }
            );
            
            await client.connect();
            
            // Проверяем, что сессия валидна
            await client.getMe();
            
            this.clients.set(userId, client);
            return client;
        } catch (error) {
            console.error(`Error creating client for user ${userId}:`, error);
            throw error;
        }
    }

    /**
     * Запускает мониторинг для пользователя
     */
    async startMonitoring(userId) {
        try {
            const user = database.users.getById(userId);
            if (!user) {
                throw new Error('User not found');
            }

            const settings = database.monitors.getByUserId(userId);
            if (!settings) {
                throw new Error('Monitor settings not found');
            }

            // Создаем клиент если его еще нет
            let client = this.clients.get(userId);
            if (!client) {
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
            database.chats.deleteByUserId(userId);
            for (const chat of chatsResult.chats) {
                database.chats.add(userId, chat.id, chat.title, chat.type);
            }

            // Получаем ID чатов для мониторинга
            const chatIds = chatsResult.chats.map(c => {
                // Преобразуем ID в правильный формат
                const id = BigInt(c.id);
                if (c.type === 'supergroup' || c.type === 'channel') {
                    return BigInt('-100' + c.id);
                }
                return -id;
            });

            console.log(`Starting monitoring for user ${userId}, ${chatIds.length} chats`);
            console.log(`Chat IDs to monitor:`, chatIds.map(id => id.toString()));

            // Устанавливаем обработчик новых сообщений
            const handler = async (event) => {
                console.log(`[Monitor] New message event received for user ${userId}`);
                await this.handleNewMessage(event, userId, user, settings);
            };

            // Слушаем все сообщения (incoming и outgoing) для тестирования
            client.addEventHandler(handler, new NewMessage({
                chats: chatIds
            }));

            // Сохраняем обработчик для возможности отключения
            client._scoutHandler = handler;

            // Активируем пользователя
            database.users.setActive(userId, true);

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
    async handleNewMessage(event, userId, user, settings) {
        try {
            const message = event.message;
            
            const msgPreview = message.message?.substring(0, 100) || '[empty]';
            console.log(`[Monitor] New message for user ${userId}: "${msgPreview}"`);
            
            // Пропускаем сервисные сообщения
            if (!message.message || message.message.length === 0) {
                console.log(`[Monitor] Skipping: empty message`);
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

            if (!matchResult.matched) {
                console.log(`[Monitor] No keyword match, skipping`);
                return;
            }
            
            console.log(`[Monitor] ✓ Match found! Sending notification...`);

            // Проверяем, не отправляли ли мы уже это уведомление
            const chatId = message.peerId?.channelId?.toString() || 
                          message.peerId?.chatId?.toString() ||
                          message.chatId?.toString();
            const messageId = message.id.toString();

            if (database.notifications.exists(userId, chatId, messageId)) {
                return;
            }

            // Получаем информацию об отправителе
            let sender;
            try {
                sender = await message.getSender();
            } catch (e) {
                sender = { id: 'unknown', firstName: 'Неизвестно' };
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
                userId: sender.id?.toString() || 'unknown',
                messageText: message.message,
                chatTitle: chat.title || 'Неизвестный чат',
                chatId: chatId,
                messageId: messageId,
                matchedKeywords: matchResult.matchedKeywords
            });

            // Отправляем уведомление через бота
            console.log(`[Monitor] User bot_chat_id: ${user.bot_chat_id}`);
            if (user.bot_chat_id) {
                try {
                    await this.bot.sendMessage(user.bot_chat_id, notification, {
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true
                    });
                    console.log(`[Monitor] ✓ Notification sent to ${user.bot_chat_id}`);

                    // Сохраняем информацию об отправленном уведомлении
                    database.notifications.add(userId, chatId, messageId);
                } catch (sendError) {
                    console.error(`[Monitor] Failed to send notification:`, sendError.message);
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

            database.users.setActive(userId, false);
            database.monitors.setActive(userId, false);

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
        
        const activeUsers = database.users.getAllActive();
        console.log(`Found ${activeUsers.length} active users in database:`, 
            activeUsers.map(u => ({ id: u.id, phone: u.phone, hasSession: !!u.session_string })));
        
        for (const user of activeUsers) {
            try {
                await this.startMonitoring(user.id);
                console.log(`Restored monitoring for user ${user.id}`);
                
                // Небольшая задержка между подключениями
                await new Promise(resolve => setTimeout(resolve, 2000));
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
}

module.exports = TelegramMonitor;
