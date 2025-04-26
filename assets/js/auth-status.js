document.addEventListener('DOMContentLoaded', async () => {
    try {
        const response = await fetch('/api/auth/check'); 
        if (!response.ok) {
            console.error('Auth check failed:', response.status, response.statusText);
            ensureLoggedOutView();
            return; 
        }
        const authStatus = await response.json();

        const navUl = document.querySelector('.main-nav .nav');
        if (!navUl) {
            console.error('Navigation UL element not found.');
            return;
        }

        const existingDropdown = navUl.querySelector('.user-dropdown-li');
        const signInLink = document.getElementById('signin-link');
        const registerLink = document.getElementById('register-link');
        
        if (existingDropdown) existingDropdown.remove();
        if (signInLink) signInLink.remove();
        if (registerLink) registerLink.remove();

        if (authStatus.isAuthenticated && authStatus.user) {
            const language = localStorage.getItem('language') || 'en';
            const dropdownLi = document.createElement('li');
            dropdownLi.classList.add('user-dropdown-li');

            const dropdownDiv = document.createElement('div');
            dropdownDiv.classList.add('user-dropdown');

            const button = document.createElement('button');
            button.classList.add('user-dropdown-button');
            button.textContent = authStatus.user.username;
            button.onclick = (event) => { 
                event.stopPropagation();
                dropdownDiv.classList.toggle('show');
            };

            const dropdownContent = document.createElement('div');
            dropdownContent.classList.add('user-dropdown-content');

            const profileLink = document.createElement('a');
            profileLink.href = '/profile';
            profileLink.textContent = language === 'ru' ? 'Профиль' : 'Profile';
            dropdownContent.appendChild(profileLink);
            const logoutLink = document.createElement('a');
            logoutLink.href = '/logout';
            logoutLink.textContent = language === 'ru' ? 'Выйти' : 'Logout';
            dropdownContent.appendChild(logoutLink);

            dropdownDiv.appendChild(button);
            dropdownDiv.appendChild(dropdownContent);
            dropdownLi.appendChild(dropdownDiv);
            navUl.appendChild(dropdownLi);

        } else {
            ensureLoggedOutView(navUl);
        }
    } catch (error) {
        console.error('Error checking authentication status:', error);
        ensureLoggedOutView();
    }
});

function ensureLoggedOutView(navUlElement) {
    const navUl = navUlElement || document.querySelector('.main-nav .nav');
    if (!navUl) return;

    const signInLink = document.getElementById('signin-link');
    const registerLink = document.getElementById('register-link');
    const existingDropdown = navUl.querySelector('.user-dropdown-li');

    if (existingDropdown) existingDropdown.remove();

    if (!signInLink) {
        const newSignInLi = document.createElement('li');
        newSignInLi.id = 'signin-link';
        const newSignInLink = document.createElement('a');
        newSignInLink.href = '/login';
        newSignInLink.textContent = 'Sign In';
        newSignInLi.appendChild(newSignInLink);
        navUl.appendChild(newSignInLi);
    }

    if (!registerLink) {
        const newRegisterLi = document.createElement('li');
        newRegisterLi.id = 'register-link';
        const newRegisterLink = document.createElement('a');
        newRegisterLink.href = '/register';
        newRegisterLink.textContent = 'Register';
        newRegisterLi.appendChild(newRegisterLink);
        navUl.appendChild(newRegisterLi);
    }
}

window.onclick = function(event) {
  if (!event.target.matches('.user-dropdown-button')) {
    var dropdowns = document.getElementsByClassName("user-dropdown");
    for (var i = 0; i < dropdowns.length; i++) {
      var openDropdown = dropdowns[i];
      if (openDropdown.classList.contains('show')) {
        openDropdown.classList.remove('show');
      }
    }
  }
}

window.updateProfileDropdownLanguage = function(lang) {
    const navUl = document.querySelector('.main-nav .nav');
    if (!navUl) return;
    const dropdownLi = navUl.querySelector('.user-dropdown-li');
    if (!dropdownLi) return;
    const links = dropdownLi.querySelectorAll('.user-dropdown-content a');
    if (links.length >= 2) {
        links[0].textContent = lang === 'ru' ? 'Профиль' : 'Profile';
        links[1].textContent = lang === 'ru' ? 'Выйти' : 'Logout';
    }
} 