/**
 * RecipeScan DB - App Logic
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    getFirestore,
    collection,
    doc,
    getDocs,
    getDoc,
    setDoc,
    deleteDoc,
    query,
    where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

class CloudStore {
    constructor(config) {
        this.app = null;
        this.db = null;
        this.userId = config.userId;

        try {
            this.app = initializeApp({
                apiKey: config.apiKey,
                authDomain: config.authDomain,
                projectId: config.projectId,
                storageBucket: config.storageBucket,
                messagingSenderId: config.messagingSenderId,
                appId: config.appId,
                measurementId: config.measurementId
            });
            this.db = getFirestore(this.app);
        } catch (err) {
            console.error("Firebase Init Error:", err);
        }
    }

    async saveRecipe(recipe) {
        if (!this.db || !this.userId) return;
        const ref = doc(this.db, "users", this.userId, "recipes", recipe.barcode);
        await setDoc(ref, recipe);
    }

    async deleteRecipe(barcode) {
        if (!this.db || !this.userId) return;
        const ref = doc(this.db, "users", this.userId, "recipes", barcode);
        await deleteDoc(ref);
    }

    async getAllRecipes() {
        if (!this.db || !this.userId) return [];
        const q = collection(this.db, "users", this.userId, "recipes");
        const querySnapshot = await getDocs(q);
        return querySnapshot.docs.map(doc => doc.data());
    }

    async saveSettings(settings) {
        if (!this.db || !this.userId) return;
        const ref = doc(this.db, "users", this.userId, "config", "appSettings");
        await setDoc(ref, settings);
    }

    async getSettings() {
        if (!this.db || !this.userId) return null;
        const ref = doc(this.db, "users", this.userId, "config", "appSettings");
        const docSnap = await getDoc(ref);
        return docSnap.exists() ? docSnap.data() : null;
    }
}

class RecipeStore {
    constructor() {
        this.dbName = 'RecipeScanDB';
        this.version = 1;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('recipes')) {
                    const store = db.createObjectStore('recipes', { keyPath: 'barcode' });
                    store.createIndex('name', 'name', { unique: false });
                    store.createIndex('date', 'date', { unique: false });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve();
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    async saveRecipe(recipe) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['recipes'], 'readwrite');
            const store = transaction.objectStore('recipes');
            recipe.date = new Date().toISOString();
            const request = store.put(recipe);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getRecipe(barcode) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['recipes'], 'readonly');
            const store = transaction.objectStore('recipes');
            const request = store.get(barcode);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAllRecipes() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['recipes'], 'readonly');
            const store = transaction.objectStore('recipes');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async deleteRecipe(barcode) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['recipes'], 'readwrite');
            const store = transaction.objectStore('recipes');
            const request = store.delete(barcode);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}

class BarcodeScanner {
    constructor(elementId, onResult) {
        this.scanner = new Html5Qrcode(elementId);
        this.onResult = onResult;
        this.config = { fps: 10, qrbox: { width: 250, height: 150 } };
    }

    async start() {
        try {
            // Explicitly request camera permissions first
            await navigator.mediaDevices.getUserMedia({ video: true });

            const cameras = await Html5Qrcode.getCameras();
            if (cameras && cameras.length > 0) {
                // Find back camera if possible, otherwise use first available
                let cameraId = cameras[0].id;
                const backCamera = cameras.find(c => c.label.toLowerCase().includes('back'));
                if (backCamera) {
                    cameraId = backCamera.id;
                } else if (cameras.length > 1) {
                    cameraId = cameras[1].id;
                }

                await this.scanner.start(
                    cameraId,
                    this.config,
                    (decodedText) => {
                        this.stop();
                        this.onResult(decodedText);
                    }
                );
            } else {
                alert('No cameras found.');
            }
        } catch (err) {
            console.error('Scanner Error:', err);
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                alert('Camera access denied. Please enable camera permissions in your browser settings to scan barcodes.');
            } else {
                alert('Could not start camera. Please check permissions and ensure no other app is using the camera.');
            }
        }
    }

    async stop() {
        if (this.scanner.isScanning) {
            await this.scanner.stop();
        }
    }
}

// Settings Controller
const Settings = {
    get() {
        return JSON.parse(localStorage.getItem('recipe_scan_settings') || '{}');
    },
    save(settings) {
        localStorage.setItem('recipe_scan_settings', JSON.stringify(settings));
    }
};

// UI Controller
const UI = {
    views: document.querySelectorAll('.view'),
    navItems: document.querySelectorAll('.nav-item'),
    store: new RecipeStore(),
    cloud: null,
    scanner: null,
    capturedImage: null,

    async init() {
        await this.store.init();
        this.loadSettings();
        this.initCloud();
        this.setupEventListeners();
        this.loadRecentRecipes();
        this.scanner = new BarcodeScanner('reader', (barcode) => this.handleScanResult(barcode));

        if (this.cloud) {
            this.syncWithCloud();
            this.syncSettingsWithCloud();
        }
    },

    initCloud() {
        const settings = Settings.get();
        if (settings.fbApiKey && settings.fbProjectId && settings.fbAppId && settings.fbUserId) {
            this.cloud = new CloudStore({
                apiKey: settings.fbApiKey,
                authDomain: settings.fbAuthDomain,
                projectId: settings.fbProjectId,
                storageBucket: settings.fbStorageBucket,
                messagingSenderId: settings.fbMessagingSenderId,
                appId: settings.fbAppId,
                measurementId: settings.fbMeasurementId,
                userId: settings.fbUserId
            });
            document.getElementById('sync-status').classList.add('online');
        } else {
            this.cloud = null;
            document.getElementById('sync-status').classList.remove('online');
        }
    },

    loadSettings() {
        const settings = Settings.get();
        document.getElementById('cloud-name').value = settings.cloudName || '';
        document.getElementById('cloudinary-api-key').value = settings.cloudinaryApiKey || '';
        document.getElementById('upload-preset').value = settings.uploadPreset || '';
        document.getElementById('cloudinary-api-secret').value = settings.cloudinaryApiSecret || '';

        // Firebase fields
        document.getElementById('fb-api-key').value = settings.fbApiKey || '';
        document.getElementById('fb-project-id').value = settings.fbProjectId || '';
        document.getElementById('fb-auth-domain').value = settings.fbAuthDomain || '';
        document.getElementById('fb-storage-bucket').value = settings.fbStorageBucket || '';
        document.getElementById('fb-messaging-sender-id').value = settings.fbMessagingSenderId || '';
        document.getElementById('fb-app-id').value = settings.fbAppId || '';
        document.getElementById('fb-measurement-id').value = settings.fbMeasurementId || '';
        document.getElementById('fb-user-id').value = settings.fbUserId || '';
    },

    setupEventListeners() {
        // Navigation
        document.querySelectorAll('[data-target]').forEach(btn => {
            btn.addEventListener('click', () => {
                const target = btn.getAttribute('data-target');
                this.switchView(target);
            });
        });

        // Scan Buttons
        document.getElementById('btn-start-scan').addEventListener('click', () => this.switchView('view-scanner'));
        document.getElementById('nav-scan').addEventListener('click', () => this.switchView('view-scanner'));

        // Photo Capture
        const cameraInput = document.getElementById('camera-input');
        const photoPreview = document.getElementById('photo-preview');

        document.getElementById('btn-take-photo').addEventListener('click', () => cameraInput.click());

        cameraInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    this.capturedImage = event.target.result;
                    photoPreview.innerHTML = `<img src="${this.capturedImage}" />`;
                    document.getElementById('btn-extract-text').disabled = false;
                };
                reader.readAsDataURL(file);
            }
        });

        // Save Recipe
        document.getElementById('btn-save-recipe').addEventListener('click', () => this.saveRecipe());

        // View All
        document.getElementById('btn-view-all').addEventListener('click', () => this.switchView('view-list'));

        // Settings
        document.getElementById('btn-settings').addEventListener('click', () => {
            this.showPasscodeModal();
        });

        // Passcode Modal Actions
        document.getElementById('btn-modal-cancel').addEventListener('click', () => this.hidePasscodeModal());
        document.getElementById('modal-passcode').addEventListener('click', (e) => {
            if (e.target.id === 'modal-passcode') this.hidePasscodeModal();
        });

        document.getElementById('btn-modal-unlock').addEventListener('click', () => this.validatePasscode());
        document.getElementById('input-passcode').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.validatePasscode();
        });

        document.getElementById('btn-save-settings').addEventListener('click', () => {
            const cloudName = document.getElementById('cloud-name').value;
            const cloudinaryApiKey = document.getElementById('cloudinary-api-key').value;
            const uploadPreset = document.getElementById('upload-preset').value;
            const cloudinaryApiSecret = document.getElementById('cloudinary-api-secret').value;

            // Firebase fields
            const fbApiKey = document.getElementById('fb-api-key').value;
            const fbProjectId = document.getElementById('fb-project-id').value;
            const fbAuthDomain = document.getElementById('fb-auth-domain').value;
            const fbStorageBucket = document.getElementById('fb-storage-bucket').value;
            const fbMessagingSenderId = document.getElementById('fb-messaging-sender-id').value;
            const fbAppId = document.getElementById('fb-app-id').value;
            const fbMeasurementId = document.getElementById('fb-measurement-id').value;
            const newSettings = {
                cloudName, cloudinaryApiKey, uploadPreset, cloudinaryApiSecret,
                fbApiKey, fbProjectId, fbAuthDomain, fbStorageBucket,
                fbMessagingSenderId, fbAppId, fbMeasurementId, fbUserId
            };
            Settings.save(newSettings);

            this.initCloud();
            if (this.cloud) {
                this.cloud.saveSettings(newSettings).catch(err => console.error("Cloud settings save failed:", err));
            }
            alert('Settings saved!');
            this.switchView('view-home');
        });

        // OCR
        document.getElementById('btn-extract-text').addEventListener('click', () => this.extractText());
    },

    switchView(viewId) {
        // Stop scanner if leaving scanner view
        if (viewId !== 'view-scanner') {
            this.scanner.stop();
        } else {
            this.scanner.start();
        }

        this.views.forEach(v => v.classList.remove('active'));
        document.getElementById(viewId).classList.add('active');

        // Update nav UI
        this.navItems.forEach(item => {
            item.classList.toggle('active', item.getAttribute('data-target') === viewId);
        });

        if (viewId === 'view-list') this.loadFullList();
    },

    async handleScanResult(barcode) {
        // Check if recipe exists
        const existing = await this.store.getRecipe(barcode);
        if (existing) {
            this.showRecipeDetail(existing);
        } else {
            // New recipe setup
            document.getElementById('recipe-barcode').value = barcode;
            document.getElementById('recipe-name').value = '';
            document.getElementById('recipe-instructions').value = '';
            document.getElementById('photo-preview').innerHTML = '<span class="placeholder">Take a photo of the instructions</span>';
            this.capturedImage = null;
            this.switchView('view-recipe-entry');
        }
    },

    async saveRecipe() {
        const barcode = document.getElementById('recipe-barcode').value;
        const name = document.getElementById('recipe-name').value;
        const instructions = document.getElementById('recipe-instructions').value;

        if (!name) return alert('Please enter a name');

        let imageUrl = this.capturedImage;

        // Try uploading to Cloudinary if settings exist
        const settings = Settings.get();
        if (settings.cloudName && settings.uploadPreset && this.capturedImage && this.capturedImage.startsWith('data:')) {
            const btn = document.getElementById('btn-save-recipe');
            const originalText = btn.innerText;
            btn.innerText = 'Uploading Image...';
            btn.disabled = true;

            try {
                imageUrl = await this.uploadToCloudinary(this.capturedImage, settings);
            } catch (err) {
                console.error('Cloudinary Upload Failed:', err);
                alert('Cloudinary upload failed. Saving image locally instead.');
            } finally {
                btn.innerText = originalText;
                btn.disabled = false;
            }
        }

        const recipe = {
            barcode,
            name,
            instructions,
            image: imageUrl
        };

        try {
            await this.store.saveRecipe(recipe);

            // Sync to cloud
            if (this.cloud) {
                this.cloud.saveRecipe(recipe).catch(err => console.error("Cloud save failed:", err));
            }

            alert('Recipe saved!');
            this.loadRecentRecipes();
            this.switchView('view-home');
        } catch (err) {
            console.error(err);
            alert('Error saving recipe');
        }
    },

    async uploadToCloudinary(base64Image, settings) {
        const formData = new FormData();
        formData.append('file', base64Image);
        formData.append('upload_preset', settings.uploadPreset);

        const response = await fetch(`https://api.cloudinary.com/v1_1/${settings.cloudName}/image/upload`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) throw new Error('Upload failed');
        const data = await response.json();
        return data.secure_url;
    },

    async extractText() {
        if (!this.capturedImage) return;

        const loader = document.getElementById('ocr-loading');
        const btn = document.getElementById('btn-extract-text');

        loader.classList.remove('hidden');
        btn.disabled = true;

        try {
            const { data: { text } } = await Tesseract.recognize(this.capturedImage, 'eng', {
                logger: m => console.log(m)
            });
            document.getElementById('recipe-instructions').value = text;
        } catch (err) {
            console.error('OCR Error:', err);
            alert('Failed to extract text from image.');
        } finally {
            loader.classList.add('hidden');
            btn.disabled = false;
        }
    },

    async loadRecentRecipes() {
        const recipes = await this.store.getAllRecipes();
        const list = document.getElementById('recent-list');
        list.innerHTML = '';

        if (recipes.length === 0) {
            list.innerHTML = '<div class="empty-state">No recipes saved yet. Scan a barcode to start!</div>';
            return;
        }

        // Sort by date desc and take top 3
        recipes.sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 3)
            .forEach(recipe => {
                list.appendChild(this.createRecipeCard(recipe));
            });
    },

    async loadFullList() {
        const recipes = await this.store.getAllRecipes();
        const list = document.getElementById('full-list');
        list.innerHTML = '';

        if (recipes.length === 0) {
            list.innerHTML = '<div class="empty-state">No recipes saved yet.</div>';
            return;
        }

        recipes.forEach(recipe => {
            list.appendChild(this.createRecipeCard(recipe));
        });
    },

    createRecipeCard(recipe) {
        const card = document.createElement('div');
        card.className = 'recipe-card';
        card.innerHTML = `
            <img src="${recipe.image || 'https://via.placeholder.com/64'}" alt="${recipe.name}">
            <div class="recipe-info">
                <h3>${recipe.name}</h3>
                <p>${recipe.barcode}</p>
            </div>
            <button class="btn-delete" title="Delete Recipe">🗑️</button>
        `;

        // Detail view on card click
        card.onclick = (e) => {
            if (e.target.classList.contains('btn-delete')) return;
            this.showRecipeDetail(recipe);
        };

        // Delete button logic
        const deleteBtn = card.querySelector('.btn-delete');
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            this.confirmDelete(recipe);
        };

        return card;
    },

    async confirmDelete(recipe) {
        if (confirm(`Are you sure you want to delete "${recipe.name}"?`)) {
            try {
                await this.store.deleteRecipe(recipe.barcode);

                // Sync to cloud
                if (this.cloud) {
                    this.cloud.deleteRecipe(recipe.barcode).catch(err => console.error("Cloud delete failed:", err));
                }

                this.loadRecentRecipes();
                if (document.getElementById('view-list').classList.contains('active')) {
                    this.loadFullList();
                }

                // If deleted from detail view, go back home
                if (document.getElementById('view-recipe-detail').classList.contains('active')) {
                    this.switchView('view-home');
                }
            } catch (err) {
                console.error('Delete failed:', err);
                alert('Failed to delete recipe.');
            }
        }
    },

    async syncWithCloud() {
        if (!this.cloud) return;

        const syncStatus = document.getElementById('sync-status');
        syncStatus.classList.add('syncing');

        try {
            const cloudRecipes = await this.cloud.getAllRecipes();
            for (const recipe of cloudRecipes) {
                await this.store.saveRecipe(recipe);
            }
            this.loadRecentRecipes();
            console.log(`Synced ${cloudRecipes.length} recipes from cloud.`);
        } catch (err) {
            console.error("Cloud sync failed:", err);
        } finally {
            syncStatus.classList.remove('syncing');
        }
    },

    async syncSettingsWithCloud() {
        if (!this.cloud) return;

        try {
            const cloudSettings = await this.cloud.getSettings();
            if (cloudSettings) {
                const localSettings = Settings.get();
                // Merge cloud settings into local, prioritizing cloud for shared config
                // (except for the Firebase config itself which is needed to connect, 
                // but we update it anyway for consistency)
                const mergedSettings = { ...localSettings, ...cloudSettings };
                Settings.save(mergedSettings);
                this.loadSettings(); // Refresh UI inputs
                console.log("Settings synced from cloud.");
            }
        } catch (err) {
            console.error("Cloud settings sync failed:", err);
        }
    },

    showRecipeDetail(recipe) {
        const container = document.getElementById('recipe-detail-content');
        container.innerHTML = `
            <div class="detail-header">
                <h2>${recipe.name}</h2>
                <button class="btn-delete-detail" id="btn-delete-recipe-detail">Delete Recipe</button>
            </div>
            <div class="meta">Barcode: ${recipe.barcode}</div>
            ${recipe.image ? `<img src="${recipe.image}" class="detail-img">` : ''}
            <div class="recipe-text">${recipe.instructions || 'No instructions provided.'}</div>
        `;

        document.getElementById('btn-delete-recipe-detail').addEventListener('click', () => {
            this.confirmDelete(recipe);
        });

        this.switchView('view-recipe-detail');
    },

    showPasscodeModal() {
        const modal = document.getElementById('modal-passcode');
        const input = document.getElementById('input-passcode');
        const error = document.getElementById('passcode-error');

        input.value = '';
        error.classList.add('hidden');
        modal.classList.remove('hidden');
        input.focus();
    },

    hidePasscodeModal() {
        document.getElementById('modal-passcode').classList.add('hidden');
    },

    validatePasscode() {
        const input = document.getElementById('input-passcode');
        const error = document.getElementById('passcode-error');

        if (input.value === '0077') {
            this.hidePasscodeModal();
            this.switchView('view-settings');
        } else {
            error.classList.remove('hidden');
            input.value = '';
            input.focus();
        }
    }
};

// Initialize on load
window.addEventListener('DOMContentLoaded', () => UI.init());
