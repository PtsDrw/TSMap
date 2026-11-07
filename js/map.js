// Инициализация карты
let panZoomInstance = null;

async function initMap() {
    const container = document.getElementById('map-container');
    
    // Загружаем SVG через fetch (нужно, чтобы работал локально. На GitHub Pages тоже будет работать)
    try {
        const response = await fetch('assets/map.svg');
        const svgText = await response.text();
        container.innerHTML = svgText;
    } catch (e) {
        console.error("Ошибка загрузки карты. Используем инлайн SVG.", e);
        // Если fetch не удался, можно вставить SVG прямо в HTML (что мы и сделали бы в продакшене)
    }

    const svgElement = document.getElementById('game-map');
    
    // Инициализация PanZoom
    panZoomInstance = svgPanZoom(svgElement, {
        zoomEnabled: true,
        controlIconsEnabled: false,
        fit: true,
        center: true,
        minZoom: 0.5,
        maxZoom: 10,
        zoomScaleSensitivity: 0.3
    });

    // Обработка кликов по территориям
    const territories = document.querySelectorAll('.territory');
    territories.forEach(territory => {
        territory.addEventListener('click', (e) => {
            // Аркадия не кликабельна (защита на уровне JS)
            if (territory.id === 'A') return;

            // Логика для страницы посетителя (просто выделение)
            // В будущем здесь будет логика для страницы управляющего
            console.log(`Клик по территории: ${territory.id}`);
            
            // Для примера: подсвечиваем выбранную территорию
            if (territory.classList.contains('selected')) {
                territory.classList.remove('selected');
            } else {
                territory.classList.add('selected');
            }
        });
    });

    // Кнопка включения/отключения подписей
    document.getElementById('btn-toggle-labels').addEventListener('click', () => {
        const labelsLayer = document.getElementById('labels');
        if (labelsLayer.style.display === 'none') {
            labelsLayer.style.display = 'block';
        } else {
            labelsLayer.style.display = 'none';
        }
    });

    // Кнопка скачивания PNG
    document.getElementById('btn-download').addEventListener('click', () => {
        // Временная логика: скачиваем контейнер с картой
        // Позже добавим модалку с выбором "с подписями / без подписей"
        html2canvas(container, { backgroundColor: null }).then(canvas => {
            const link = document.createElement('a');
            link.download = 'map.png';
            link.href = canvas.toDataURL('image/png');
            link.click();
        });
    });
}

// Переключение темы
function initTheme() {
    const btnTheme = document.getElementById('btn-theme');
    const html = document.documentElement;
    
    // Проверка сохраненной темы
    if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        html.classList.add('dark');
        btnTheme.innerHTML = '<i class="fas fa-sun"></i>';
    }

    btnTheme.addEventListener('click', () => {
        html.classList.toggle('dark');
        if (html.classList.contains('dark')) {
            localStorage.setItem('theme', 'dark');
            btnTheme.innerHTML = '<i class="fas fa-sun"></i>';
        } else {
            localStorage.setItem('theme', 'light');
            btnTheme.innerHTML = '<i class="fas fa-moon"></i>';
        }
    });
}

// Модальное окно авторизации
function initAuthModal() {
    const modal = document.getElementById('modal-auth');
    const btnAdmin = document.getElementById('btn-admin');
    const btnClose = document.getElementById('btn-close-auth');
    const step1 = document.getElementById('auth-step-1');
    const step2 = document.getElementById('auth-step-2');
    const btnAdminAuth = document.getElementById('btn-admin-auth');
    const btnBack = document.getElementById('btn-back-auth');

    btnAdmin.addEventListener('click', () => modal.classList.remove('hidden'));
    btnClose.addEventListener('click', () => modal.classList.add('hidden'));
    
    btnAdminAuth.addEventListener('click', () => {
        step1.classList.add('hidden');
        step2.classList.remove('hidden');
    });
    
    btnBack.addEventListener('click', () => {
        step2.classList.add('hidden');
        step1.classList.remove('hidden');
    });
}

// Запуск приложения
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initMap();
    initAuthModal();
});