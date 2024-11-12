import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { WechatferryPuppet } from '@wechatferry/puppet';
import { WechatyBuilder } from 'wechaty';
import OpenAI from 'openai';
import config from './config.json' assert { type: 'json' };
import { log } from './src/utils/logger.js';
import { ChatHistoryManager } from './src/services/chatHistory.js';
import { SearchService } from './src/services/searchService.js';
import { PromptManager } from './src/services/promptManager.js';
import { URLReaderService } from './src/services/urlReader.js';

const model = config.openai.model;
const openai = new OpenAI({
  baseURL: config.openai.baseURL,
  apiKey: config.openai.apiKey,
});

const puppet = new WechatferryPuppet();
const bot = WechatyBuilder.build({ puppet });
const promptManager = new PromptManager();
const historyManager = new ChatHistoryManager(config.maxHistoryLength);
const searchService = new SearchService(config.searchEngineURL);
const urlReaderService = new URLReaderService();

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
  }
];

async function processMessage(userMessage, chatId) {
  try {
    const systemPrompt = promptManager.getSystemPrompt(chatId, userMessage);
    const messageContent = promptManager.extractMessageContent(userMessage);

    if (promptManager.isPromptSwitchCommand(userMessage) && !messageContent) {
      return '已切换系统提示词。';
    }

    historyManager.updateHistory(chatId, 'user', messageContent);
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
          if (toolCall.function.name === 'search_internet') {
              log('info', 'search_internet tool call detected');
              const args = JSON.parse(toolCall.function.arguments);
              toolResponse = await searchService.search(args.keywords);
          } else if (toolCall.function.name === 'read_url') {
              log('info', 'read_url tool call detected');
              const args = JSON.parse(toolCall.function.arguments);
              toolResponse = await urlReaderService.readURL(args.url);
          } else if (toolCall.function.name === 'get_today_news') {
            log('info', 'get_today_news tool call detected');
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

      const reply = await processMessage(userMessage, room.id);
      await msg.say(reply);
    }
  } else {
    log('info', `Message in private chat: ${text}`);

    const reply = await processMessage(text, talker.id);
    await msg.say(reply);
  }
});

process.on('exit', () => {
  historyManager.saveHistory();
});

const argv = yargs(hideBin(process.argv))
  .command('help', 'Display help information', () => {}, (argv) => {
    console.log(`
Usage: aider [options]

Options:
  --help  Display this help message
    `);
  })
  .help()
  .argv;

if (!argv._.length) {
  bot.start()
    .then(() => log('info', 'Bot started'))
    .catch(error => log('error', `Failed to start bot: ${error}`));
}
