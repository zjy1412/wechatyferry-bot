import { WechatferryPuppet } from '@wechatferry/puppet';
import { WechatyBuilder } from 'wechaty';
import OpenAI from 'openai';
import config from './config.json' assert { type: 'json' };
import { log } from './src/utils/logger.js';
import { ChatHistoryManager } from './src/services/chatHistory.js';
import { SearchService } from './src/services/searchService.js';
import { PromptManager } from './src/services/promptManager.js';
import { URLReaderService } from './src/services/urlReader.js';
import { FileReaderService } from './src/services/fileReaderService.js';

const model = config.openai.model;
const openai = new OpenAI({
  baseURL: config.openai.baseURL,
  apiKey: config.openai.apiKey,
});

const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds

async function initializeBot() {
  let currentRetry = 0;
  
  while (currentRetry < MAX_RETRIES) {
    try {
      const puppet = new WechatferryPuppet({
        timeout: 30000, // 30 seconds timeout
      });
      
      const bot = WechatyBuilder.build({ 
        puppet,
        puppetOptions: {
          timeout: 30000,
        }
      });

      const promptManager = new PromptManager();
      const historyManager = new ChatHistoryManager(config.maxHistoryLength);
      const searchService = new SearchService(config.searchEngineURL);
      const fileReaderService = new FileReaderService();
      const urlReaderService = new URLReaderService();

      // Tool definitions remain the same
      const tools = [
        {
          type: "function",
          function: {
            name: "search_internet",
            description: "Search the internet for current information using SearXNG",
            parameters: {
              type: "object",
              properties: {
                keywords: {
                  type: "array",
                  items: { type: "string" },
                  description: "Search keywords list. Example: ['Python', 'machine learning', 'latest developments']"
                }
              },
              required: ["keywords"]
            }
          },
        },
        {
          type: "function",
          function: {
            name: "read_url",
            description: "Read and extract content from a URL (webpage or PDF)",
            parameters: {
              type: "object",
              properties: {
                url: {
                  type: "string",
                  description: "The URL to read (supports webpages and PDFs)"
                }
              },
              required: ["url"]
            }
          }
        },
        {
          type: "function",
          function: {
            name: "get_today_news",
            description: "Get today's news summary, only used when the message includes the word news or '新闻'",
            parameters: {
              type: "object",
              properties: {},
              required: []
            }
          }
        },
        {
          type: "function",
          function: {
            name: "summarize_chat",
            description: "Summarize the chat history when requested",
            parameters: {
              type: "object",
              properties: {
                chatId: {
                  type: "string",
                  description: "The ID of the chat to summarize"
                }
              },
              required: ["chatId"]
            }
          }
        }
      ];

      async function processMessage(userMessage, chatId, username = '') {
        try {
          const systemPrompt = promptManager.getSystemPrompt(chatId, userMessage);
          const messageContent = promptManager.extractMessageContent(userMessage);

          if (promptManager.isPromptSwitchCommand(userMessage) && !messageContent) {
            return '已切换系统提示词。';
          }

          historyManager.updateHistory(chatId, 'user', messageContent, username);
          const history = historyManager.getHistory(chatId);

          const initialResponse = await openai.chat.completions.create({
            messages: [
              { role: 'user', content: messageContent }
            ],
            model: model,
            tools: tools
          });

          const responseMessage = initialResponse.choices[0].message;
          
          if (responseMessage.tool_calls) {
            const toolCall = responseMessage.tool_calls[0];
            let toolResponse;

            try {
              if (toolCall.function.name === 'summarize_chat') {
                const args = JSON.parse(toolCall.function.arguments);
                toolResponse = await historyManager.summarizeChat(args.chatId);
              } else if (toolCall.function.name === 'search_internet') {
                const args = JSON.parse(toolCall.function.arguments);
                toolResponse = await searchService.search(args.keywords);
              } else if (toolCall.function.name === 'read_url') {
                const args = JSON.parse(toolCall.function.arguments);
                toolResponse = await urlReaderService.readURL(args.url);
              } else if (toolCall.function.name === 'get_today_news') {
                toolResponse = await urlReaderService.readURL('https://api.lbbb.cc/api/60miao');
              }
            } catch (error) {
              log('error', `Tool execution failed: ${error}`);
              return `工具执行失败: ${error.message}`;
            }

            log('info', `Tool response: ${JSON.stringify(toolResponse)}`);

            const finalResponse = await openai.chat.completions.create({
              messages: [
                systemPrompt,
                ...history,
                responseMessage,
                {
                  role: 'tool',
                  content: JSON.stringify(toolResponse),
                  tool_call_id: toolCall.id
                }
              ],
              model: model,
            });

            const botReply = finalResponse.choices[0].message.content;
            historyManager.updateHistory(chatId, 'assistant', botReply);
            return botReply;
          }

          const secondResponse = await openai.chat.completions.create({
            messages: [
              systemPrompt,
              ...history,
              { role: 'user', content: messageContent }
            ],
            model: model,
          });
          
          const botReply = secondResponse.choices[0].message.content;
          historyManager.updateHistory(chatId, 'assistant', botReply);
          return botReply;
        } catch (error) {
          log('error', `Error processing message: ${error}`);
          return '抱歉，我目前无法回答您的问题。';
        }
      }

      bot.on('scan', (qrcode, status) => {
        log('info', `Scan QR Code to login: ${status}`);
      });

      bot.on('login', (user) => {
        log('info', `User ${user} logged in`);
      });

      bot.on('message', async (msg) => {
        if (msg.self()) return;

        const room = msg.room();
        const talker = msg.talker();
        const botName = bot.currentUser.name();
        const text = msg.text().trim();

        if (room) {
          if (await msg.mentionSelf()) {
            const userMessage = text.replace(new RegExp(`@${botName}\\s?`, 'g'), '').trim();
            log('info', `Message in group with @: ${userMessage}`);

            const reply = await processMessage(userMessage, room.id, talker.name());
            await msg.say(reply);
          }
        } else {
          log('info', `Message in private chat: ${text}`);

          if (msg.type() === bot.Message.Type.Attachment) {
            const file = msg.toFileBox();
            const reply = await fileReaderService.handleFileMessage(file);
            await msg.say(reply);
          } else {
            const reply = await processMessage(text, talker.id, talker.name());
          await msg.say(reply);
        }
      });

      // Handle graceful shutdown
      process.on('SIGINT', async () => {
        log('info', 'Received SIGINT. Saving state and shutting down...');
        await bot.stop();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        log('info', 'Received SIGTERM. Saving state and shutting down...');
        await bot.stop();
        process.exit(0);
      });

      // Start the bot
      await bot.start();
      log('info', 'Bot started successfully');
      return true;

    } catch (error) {
      currentRetry++;
      log('error', `Failed to start bot (attempt ${currentRetry}/${MAX_RETRIES}): ${error}`);
      
      if (currentRetry < MAX_RETRIES) {
        log('info', `Retrying in ${RETRY_DELAY/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        log('error', 'Max retries reached. Unable to start bot.');
        throw error;
      }
    }
  }
}

// Initialize the bot with retry mechanism
initializeBot()
  .catch(error => {
    log('error', `Fatal error: ${error}`);
    process.exit(1);
  });
