const https = require('https');
const xml2js = require('xml2js');

const DIGISELLER_API_URL = "https://api.digiseller.com/api/";
const SELLER_ID = "750992";

function fetchCategories() {
  const url = `${DIGISELLER_API_URL}categories?seller_id=${SELLER_ID}`;
  https.get(url, (res) => {
    console.log("Статус-код ответа:", res.statusCode);
    console.log("Заголовки ответа:", res.headers);

    let data = '';

    // Накопление данных
    res.on('data', (chunk) => { data += chunk; });

    res.on('end', () => {
      console.log("Полученные данные:\n", data);
      
      // Создаём парсер с опциями, чтобы не было вложенных массивов для простых значений
      const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
      parser.parseString(data, (err, result) => {
        if (err) {
          console.error("Ошибка при парсинге XML:", err);
          return;
        }
        // Проверяем наличие данных о категориях
        const response = result['digiseller.response'];
        if (response && response.categories && response.categories.category) {
          let categories = response.categories.category;
          // Если всего одна категория – приводим к массиву
          if (!Array.isArray(categories)) {
            categories = [categories];
          }
          // Выводим данные
          categories.forEach(category => {
            console.log(`ID: ${category.id}, Название: ${category.name}, Количество: ${category.cnt}`);
          });
        } else {
          console.log("Нет данных о категориях.");
        }
      });
    });
  }).on('error', (err) => {
    console.error("Ошибка при выполнении запроса:", err);
  });
}

fetchCategories();
