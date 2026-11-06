const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xposeLive', {
  deliver: (url, body) => ipcRenderer.send('live-net-body', { url, body }),
});

contextBridge.exposeInMainWorld('api', {
  switchTabs: () => {
    const element = document.querySelector('[data-testid="primaryColumn"]');
    const links = element.querySelectorAll('a[href="/home"]');
    const forYouTab = links[0];
    const followingTab = links[1];
    if (forYouTab.getAttribute('aria-selected') === 'false') {
      forYouTab.click();
    } else if (followingTab.getAttribute('aria-selected') === 'false') {
      followingTab.click();
    }
  },
});
