document.addEventListener('DOMContentLoaded', function() {
  const addToCartButton = document.getElementById('add-to-cart');
  if (!addToCartButton) return;
  
  addToCartButton.addEventListener('click', function() {
    const urlParams = new URLSearchParams(window.location.search);
    let productId = urlParams.get('id');
    
    if (!productId) {
      const pathMatch = window.location.pathname.match(/\/product\/(\d+)/);
      if (pathMatch && pathMatch[1]) {
        productId = pathMatch[1];
      } else {
        productId = 1;
      }
    }
    
    const quantity = parseInt(document.getElementById('quantity-input')?.value) || 1;
    
    fetch('/api/auth/check')
      .then(response => {
        if (!response.ok) {
          throw new Error(`Network error: ${response.status}`);
        }
        return response.json();
      })
      .then(data => {
        if (data.isAuthenticated) {
          return fetch('/api/cart', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              productId,
              quantity
            })
          });
        } else {
          return fetch('/api/cart', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              productId,
              quantity
            })
          });
        }
      })
      .then(response => {
        if (!response.ok) {
          throw new Error(`Server error: ${response.status}`);
        }
        return response.json();
      })
      .then(data => {
        if (data.success) {
          const language = localStorage.getItem('language') || 'en';
          alert(language === 'ru' ? 
            'Товар добавлен в корзину!' : 
            'Item added to cart!');
          
          window.location.href = '/cart';
        } else {
          throw new Error(data.error || 'Failed to add item to cart');
        }
      })
      .catch(err => {
        console.error('Error adding item to cart:', err);
        const language = localStorage.getItem('language') || 'en';
        alert(language === 'ru' ? 
          'Ошибка при добавлении товара в корзину. Пожалуйста, попробуйте еще раз.' : 
          'Error adding item to cart. Please try again.');
      });
  });
  
  document.querySelectorAll('.remove-from-cart').forEach(button => {
    button.addEventListener('click', function() {
      const productId = this.getAttribute('data-product-id');
      
      fetch(`/api/cart/${productId}`, {
        method: 'DELETE'
      })
      .then(response => response.json())
      .then(data => {
        if (data.success) {
          window.location.reload();
        }
      })
      .catch(err => {
        console.error('Error removing item from cart:', err);
        const language = localStorage.getItem('language') || 'en';
        alert(language === 'ru' ? 
          'Ошибка при удалении товара из корзины. Пожалуйста, попробуйте еще раз.' : 
          'Error removing item from cart. Please try again.');
      });
    });
  });
  
  document.querySelectorAll('.update-quantity').forEach(input => {
    input.addEventListener('change', function() {
      const productId = this.getAttribute('data-product-id');
      const quantity = parseInt(this.value) || 1;
      
      fetch(`/api/cart/${productId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ quantity })
      })
      .then(response => response.json())
      .then(data => {
        if (data.success) {
          window.location.reload();
        }
      })
      .catch(err => {
        console.error('Error updating quantity:', err);
        const language = localStorage.getItem('language') || 'en';
        alert(language === 'ru' ? 
          'Ошибка при обновлении количества. Пожалуйста, попробуйте еще раз.' : 
          'Error updating quantity. Please try again.');
      });
    });
  });
}); 