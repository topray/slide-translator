// utils/storage.js

export async function getStorageValue(key) {
  const result = await chrome.storage.local.get(key);
  return result[key];
}

export async function setStorageValue(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function removeStorageValue(key) {
  await chrome.storage.local.remove(key);
}

export async function clearAllStorage() {
  await chrome.storage.local.clear();
}
