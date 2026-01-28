/**
 * RecipeScan DB - App Logic
 */

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
}

class BarcodeScanner {
    constructor(elementId, onResult) {
        this.scanner = new Html5Qrcode(elementId);
        this.onResult = onResult;
        this.config = { fps: 10, qrbox: { width: 250, height: 150 } };
    }

    async start() {
        try {
            const cameras = await Html5Qrcode.getCameras();
            if (cameras && cameras.length > 0) {
                const cameraId = cameras.length > 1 ? cameras[1].id : cameras[0].id; // Prefer back camera
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
            alert('Could not start camera. Please check permissions.');
        }
    }

    async stop() {
        if (this.scanner.isScanning) {
            await this.scanner.stop();
        }
    }
}

// UI Controller
const UI = {
    views: document.querySelectorAll('.view'),
    navItems: document.querySelectorAll('.nav-item'),
    store: new RecipeStore(),
    scanner: null,
    capturedImage: null,

    async init() {
        await this.store.init();
        this.setupEventListeners();
        this.loadRecentRecipes();
        this.scanner = new BarcodeScanner('reader', (barcode) => this.handleScanResult(barcode));
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
                };
                reader.readAsDataURL(file);
            }
        });

        // Save Recipe
        document.getElementById('btn-save-recipe').addEventListener('click', () => this.saveRecipe());

        // View All
        document.getElementById('btn-view-all').addEventListener('click', () => this.switchView('view-list'));
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

        const recipe = {
            barcode,
            name,
            instructions,
            image: this.capturedImage
        };

        try {
            await this.store.saveRecipe(recipe);
            alert('Recipe saved!');
            this.loadRecentRecipes();
            this.switchView('view-home');
        } catch (err) {
            console.error(err);
            alert('Error saving recipe');
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
        `;
        card.onclick = () => this.showRecipeDetail(recipe);
        return card;
    },

    showRecipeDetail(recipe) {
        const container = document.getElementById('recipe-detail-content');
        container.innerHTML = `
            <h2>${recipe.name}</h2>
            <div class="meta">Barcode: ${recipe.barcode}</div>
            ${recipe.image ? `<img src="${recipe.image}" class="detail-img">` : ''}
            <div class="recipe-text">${recipe.instructions || 'No instructions provided.'}</div>
        `;
        this.switchView('view-recipe-detail');
    }
};

// Initialize on load
window.addEventListener('DOMContentLoaded', () => UI.init());
