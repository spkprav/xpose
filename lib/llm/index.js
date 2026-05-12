const GLMClient = require('./glm');
const OpenRouterClient = require('./openrouter');

const clients = {
  glm: GLMClient,
  openrouter: OpenRouterClient,
  // ollama: OllamaClient,
  // openai: OpenAIClient,
};

function createClient(provider, config) {
  const Client = clients[provider];
  if (!Client) {
    throw new Error(`Unsupported LLM provider: ${provider}`);
  }
  return new Client(config);
}

module.exports = {
  createClient,
  GLMClient,
};
