const TelegramBot = require('node-telegram-bot-api');
const database = require('./database');

// ID администратора (твой Telegram ID)
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || '278263484';

class NotificationBot {
    constructor(token) {
        this.bot = new TelegramBot(token, { polling: true });
        this.monitor = null; // Будет установлен позже
        this.setupHandlers();
    }

    setMonitor(monitor) {
        this.monitor = monitor;
    }

    setupHandlers() {
        // Обработка команды /start
        this.bot.onText(/\/start(.*)/, async (msg, match) => {
            const chatId = msg.chat.id;
            const userId = msg.from.id.toString();
            const username = msg.from.username;
            
            console.log(`[Bot] /start from user ${userId} (${username}), chatId: ${chatId}`);
            
            // Сохраняем всех кто нажал /start для статистики
            await database.botUsers.upsert(
                userId,
                username,
                msg.from.first_name,
                msg.from.last_name,
                msg.from.language_code
            );
            
            // Проверяем есть ли параметр (для deep linking)
            const param = match[1]?.trim();
            
            // Сохраняем chat_id для отправки уведомлений
            const existingUser = await database.users.getByTelegramId(userId);
            console.log(`[Bot] Existing user found:`, existingUser ? `id=${existingUser.id}, bot_chat_id=${existingUser.bot_chat_id}` : 'null');
            
            if (existingUser) {
                await database.users.updateBotChatId(userId, chatId.toString());
                console.log(`[Bot] Updated bot_chat_id to ${chatId} for user ${userId}`);
                
                // Проверяем что обновилось
                const updatedUser = await database.users.getByTelegramId(userId);
                console.log(`[Bot] After update, bot_chat_id:`, updatedUser?.bot_chat_id);
            } else {
                console.log(`[Bot] User not found in DB. They need to configure via web first.`);
            }

            const welcomeMessage = `
🔍 *Scout Bot - Бот-разведчик*

Привет! Я помогу отслеживать интересные сообщения в твоих чатах.

*Как начать:*
1️⃣ Перейди на сайт настройки
2️⃣ Введи свои Telegram API данные
3️⃣ Выбери папку с чатами для мониторинга
4️⃣ Укажи ключевые слова для поиска
5️⃣ Получай уведомления прямо сюда!

*Команды:*
/status - проверить статус мониторинга
/stop - остановить мониторинг
/help - показать справку

📱 *Настройка:* ${process.env.BASE_URL || 'http://localhost:3000'}
            `;

            const baseUrl = process.env.BASE_URL || '';
            const replyOptions = {
                parse_mode: 'Markdown'
            };
            
            // Добавляем inline кнопку только если есть публичный URL (не localhost)
            if (baseUrl && !baseUrl.includes('localhost')) {
                replyOptions.reply_markup = {
                    inline_keyboard: [
                        [{ text: '⚙️ Настроить мониторинг', url: `${baseUrl}?user=${userId}` }]
                    ]
                };
            }

            await this.bot.sendMessage(chatId, welcomeMessage, replyOptions);
        });

        // Обработка команды /admin (только для администратора)
        this.bot.onText(/\/admin/, async (msg) => {
            const chatId = msg.chat.id;
            const userId = msg.from.id.toString();

            if (userId !== ADMIN_ID) {
                await this.bot.sendMessage(chatId, '❌ У вас нет доступа к этой команде.');
                return;
            }

            try {
                const totalBotUsers = await database.botUsers.count();
                const totalConfiguredUsers = await database.users.count();
                const activeMonitorings = await database.users.countActive();
                const stats = await database.stats.getTotal();
                const todayStats = await database.stats.getToday();

                const message = `
📊 *Статистика Scout Bot*

👥 *Пользователи:*
├ Всего нажали /start: ${totalBotUsers}
├ Настроили мониторинг: ${totalConfiguredUsers}
└ Активных мониторингов: ${activeMonitorings}

📈 *За всё время:*
├ Сообщений обработано: ${stats?.messages_processed || 0}
├ Совпадений найдено: ${stats?.matches_found || 0}
└ Уведомлений отправлено: ${stats?.notifications_sent || 0}

📅 *Сегодня:*
├ Сообщений обработано: ${todayStats?.messages_processed || 0}
├ Совпадений найдено: ${todayStats?.matches_found || 0}
└ Уведомлений отправлено: ${todayStats?.notifications_sent || 0}
                `;

                await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } catch (error) {
                console.error('[Bot] Admin command error:', error);
                await this.bot.sendMessage(chatId, `❌ Ошибка: ${error.message}`);
            }
        });

        // Обработка команды /status
        this.bot.onText(/\/status/, async (msg) => {
            const chatId = msg.chat.id;
            const userId = msg.from.id.toString();

            const user = await database.users.getByTelegramId(userId);
            
            if (!user) {
                await this.bot.sendMessage(chatId, 
                    '❌ Вы еще не настроили мониторинг.\n\nИспользуйте /start для начала.',
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            const settings = await database.monitors.getByUserId(user.id);
            const chatsCount = await database.chats.count(user.id);

            const statusEmoji = user.is_active ? '✅' : '⏸️';
            const statusText = user.is_active ? 'Активен' : 'Остановлен';

            let message = `
${statusEmoji} *Статус мониторинга:* ${statusText}

📁 *Папка:* ${settings?.folder_name || 'Не выбрана'}
💬 *Чатов в мониторинге:* ${chatsCount}
🔑 *Ключевые слова:* ${settings?.keywords?.join(', ') || 'Не заданы'}

📅 *Создан:* ${new Date(user.created_at).toLocaleDateString('ru-RU')}
            `;

            await this.bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: user.is_active ? [
                        [{ text: '⏹️ Остановить мониторинг', callback_data: 'stop_monitoring' }]
                    ] : [
                        [{ text: '▶️ Запустить мониторинг', callback_data: 'start_monitoring' }],
                        [{ text: '⚙️ Настройки', url: `${process.env.BASE_URL || 'http://localhost:3000'}?user=${userId}` }]
                    ]
                }
            });
        });

        // Обработка команды /stop
        this.bot.onText(/\/stop/, async (msg) => {
            const chatId = msg.chat.id;
            const userId = msg.from.id.toString();

            const user = await database.users.getByTelegramId(userId);
            
            if (!user) {
                await this.bot.sendMessage(chatId, 
                    '❌ Мониторинг не настроен.',
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            if (this.monitor) {
                await this.monitor.stopMonitoring(user.id);
            }

            await this.bot.sendMessage(chatId, 
                '⏹️ Мониторинг остановлен.\n\nИспользуйте /start для повторного запуска.',
                { parse_mode: 'Markdown' }
            );
        });

        // Обработка команды /help
        this.bot.onText(/\/help/, async (msg) => {
            const chatId = msg.chat.id;

            const helpMessage = `
📖 *Справка по Scout Bot*

*Что делает бот:*
Отслеживает сообщения в выбранных чатах и уведомляет вас, когда находит сообщения с нужными ключевыми словами.

*Как работает:*
1. Вы подключаете свой Telegram аккаунт через MTProto API
2. Выбираете папку с чатами для мониторинга
3. Указываете ключевые слова
4. Бот следит за новыми сообщениями и присылает уведомления

*Ограничения (для защиты от бана):*
• Максимум 50 чатов в мониторинге
• Только групповые чаты (не личные)
• Только новые сообщения (не история)
• Бот не отправляет сообщения в чаты

*Команды:*
/start - начать работу
/status - статус мониторинга
/stop - остановить мониторинг
/help - эта справка

*Безопасность:*
• Ваши данные хранятся в зашифрованном виде
• Мы не читаем ваши личные сообщения
• Сессия привязана только к этому сервису
            `;

            await this.bot.sendMessage(chatId, helpMessage, {
                parse_mode: 'Markdown'
            });
        });

        // Обработка callback кнопок
        this.bot.on('callback_query', async (query) => {
            const chatId = query.message.chat.id;
            const userId = query.from.id.toString();
            const data = query.data;

            if (data === 'stop_monitoring') {
                const user = await database.users.getByTelegramId(userId);
                if (user && this.monitor) {
                    await this.monitor.stopMonitoring(user.id);
                    await this.bot.answerCallbackQuery(query.id, {
                        text: 'Мониторинг остановлен'
                    });
                    await this.bot.sendMessage(chatId, '⏹️ Мониторинг остановлен.');
                }
            }

            if (data === 'start_monitoring') {
                const user = await database.users.getByTelegramId(userId);
                if (user && this.monitor) {
                    const result = await this.monitor.startMonitoring(user.id);
                    if (result.success) {
                        await this.bot.answerCallbackQuery(query.id, {
                            text: 'Мониторинг запущен!'
                        });
                        await this.bot.sendMessage(chatId, 
                            `▶️ Мониторинг запущен!\n\nОтслеживается чатов: ${result.chatsCount}`
                        );
                    } else {
                        await this.bot.answerCallbackQuery(query.id, {
                            text: 'Ошибка запуска'
                        });
                        await this.bot.sendMessage(chatId, 
                            `❌ Ошибка запуска: ${result.error}\n\nПроверьте настройки.`
                        );
                    }
                }
            }
        });

        // Логирование ошибок
        this.bot.on('polling_error', (error) => {
            console.error('Bot polling error:', error.message);
        });
    }

    /**
     * Отправка сообщения пользователю
     */
    async sendMessage(chatId, message, options = {}) {
        try {
            return await this.bot.sendMessage(chatId, message, options);
        } catch (error) {
            console.error('Error sending message:', error);
            throw error;
        }
    }

    /**
     * Остановка бота
     */
    stop() {
        this.bot.stopPolling();
    }
}

module.exports = NotificationBot;
