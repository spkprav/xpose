const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Settings {
  constructor() {
    this.settingsPath = path.join(app.getPath('userData'), 'settings.json');
    this.defaults = {
      // 'x' | 'linkedin' — drives top-level platform mode swap.
      activePlatform: 'x',
      // User-local identity. Pre-fills ICP prompts, search seeds, outreach
      // context. EMPTY in the open-source repo. User edits via Settings panel.
      identity: {
        handle:          '',
        display_name:    '',
        location:        '',
        product:         '',
        positioning:     '',
        outreach_context:'',
        icp: { x: '', linkedin: '' },
        li_search_seeds: [],
        x_search_seeds:  [],
      },
      llmProvider: 'ollama',
      // Backend used by lib/feed/score-tweets.js for list-feed scoring.
      // 'ollama' = local model via CONFIG.baseUrl. 'openrouter' = hosted model via API key.
      scoringProvider: 'ollama',
      // OpenRouter model used specifically for scoring (separate from `openrouter.model`
      // which is the chat/reply model). Vision still runs locally on Ollama.
      scoringOpenrouterModel: 'google/gemini-2.5-flash',
      icpCriteria: '',
      profile: null,
      // Personal X list URLs go here, one per line. Empty by default. configure in Settings.
      feedLinks: '',
      // X-list IDs for the Lists tab (per-slug). Numeric ID from x.com/i/lists/<id>.
      lists: {
        'anchors': '',
        'venues': '',
        'mutuals-rising': '',
        'high-velocity-replies': '',
        'growth-study': '',
      },
      // Auto-crawl all configured lists on an interval. enabled=true + running=true
      // means the scheduler fires. running=false = paused.
      // startTime: optional "HH:MM" (24h, local). If set, cadence is anchored:
      //   slots = startTime, startTime+interval, startTime+2*interval, …
      //   On enable, the next slot ≥ now is scheduled.
      // If startTime is empty, the first run fires immediately on enable, then every interval.
      listAutoCrawl: {
        enabled: false,
        running: false,
        intervalMinutes: 60,
        startTime: '',
      },
      // Outbound Telegram (push high-score list tweets after each crawl).
      telegram: {
        enabled: false,
        botToken: '',
        chatId: '',
        minScore: 60,
        maxPerCrawl: 10,
        hoursWindow: 3,
      },
      database: {
        host: 'localhost',
        port: 5432,
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
        const saved = JSON.parse(raw);
        const merged = { ...this.defaults, ...saved };
        // Deep-merge object-valued defaults so a new nested key (added in a future
        // version) shows up even if the user's settings.json was written earlier.
        for (const k of Object.keys(this.defaults)) {
          const dv = this.defaults[k];
          if (dv && typeof dv === 'object' && !Array.isArray(dv)) {
            merged[k] = { ...dv, ...(saved[k] || {}) };
          }
        }
        return merged;
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
