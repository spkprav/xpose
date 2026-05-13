const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Settings {
  constructor() {
    this.settingsPath = path.join(app.getPath('userData'), 'settings.json');
    this.defaults = {
      llmProvider: 'ollama',
      icpCriteria: '',
      profile: null,
      // Personal X list URLs go here, one per line. Empty by default. configure in Settings.
      feedLinks: '',
      database: {
        host: 'localhost',
        port: 54329,
        user: 'postgres',
        password: 'postgres',
        database: 'xpose',
      },
      ollama: {
        baseUrl: 'http://localhost:11434',
        model: 'llama3',
      },
      openrouter: {
        apiKey: '',
        model: 'anthropic/claude-3-haiku',
      },
      glm: {
        apiKey: '',
        model: 'glm-4-flash',
      },
      openai: {
        apiKey: '',
        model: 'gpt-4o-mini',
      },
    };
    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const raw = fs.readFileSync(this.settingsPath, 'utf8');
        return { ...this.defaults, ...JSON.parse(raw) };
      }
    } catch (err) {
      console.error('Error loading settings:', err.message);
    }
    return { ...this.defaults };
  }

  save() {
    try {
      const dir = path.dirname(this.settingsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.data, null, 2));
      return true;
    } catch (err) {
      console.error('Error saving settings:', err.message);
      return false;
    }
  }

  get(key) {
    return key ? this.data[key] : this.data;
  }

  set(key, value) {
    this.data[key] = value;
    return this.save();
  }

  update(updates) {
    this.data = { ...this.data, ...updates };
    return this.save();
  }

  getActiveProvider() {
    const provider = this.data.llmProvider;
    return {
      provider,
      config: this.data[provider],
    };
  }
}

module.exports = Settings;
