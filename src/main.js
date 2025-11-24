// 2025-11-23

// Se importa Actor de 'apify', pero las herramientas de rastreo son de 'crawlee'
import { Actor } from 'apify';

// Importamos clases principales de 'crawlee'
import { CheerioCrawler, RequestQueue, KeyValueStore, Dataset } from 'crawlee';

// CONFIGURACION
// Las palabras clave que se buscaran en los enlaces (<a>)
const KEYWORDS = [
    'affiliate', 'partner', 'program', 'join', 'referral',
    'collab', 'colabora', 'monetize', 'embassador', 'socios',
    'developers', 'integrations'
];
// Limite de profundidad de rastreo para no sobrecargar el sitio
const MAX_DEPTH = 4;


// INICIO DEL ACTOR
// El actor se inicializa con una funcion autoejecutable
await Actor.main(async () => {

    // #region Variables
    ///<summary>Almacenamiento clave-valor para la configuracion y estado</summary>
    const _input = await Actor.getInput();

    ///<summary>Dataset para guardar los resultados de los programas encontrados</summary>
    const _resultsDataset = await Dataset.open('AFFILIATE-PROGRAMS');
    // #endregion Variables

    // #region Funciones Internas

    ///<summary>Funcion que procesa cada pagina rastreada</summary>
    const handlePageFunction = async ({ request, $, enqueueLinks }) => {

        const currentUrl = request.url;
        const currentDepth = request.userData.depth;

        // La logica de extraccion va aqui, llama a las Funciones Externas

        // 1. Si YA estamos en la pagina del programa, extraemos la info de contacto INMEDIATAMENTE
        if (request.userData.isPartnerPage) {
            console.log(`Extrayendo datos de: ${currentUrl}`);
            const contactInfo = extractContactInfo($, currentUrl, request.userData.sourceUrl);
            await _resultsDataset.pushData(contactInfo);
            return; // Terminamos aqui para esta URL
        }

        // 2. Buscamos enlaces de afiliados en la pagina actual
        console.log(`Procesando: ${currentUrl} (Depth: ${currentDepth})`);
        const partnerLink = findPartnerLink($, currentUrl);
        if (partnerLink) console.log(`Encontrado Partner Link en ${currentUrl}: ${partnerLink}`);

        if (partnerLink) {

            // Si encontramos un enlace potencial, lo anadimos a la cola con profundidad 
            // mayor para que se procese como la pagina del programa de afiliados

            await _requestQueue.addRequest({
                url: partnerLink,
                userData: {
                    depth: currentDepth + 1,
                    isPartnerPage: true, // Marcamos que esta es la pagina importante
                    sourceUrl: currentUrl
                }
            });

        } else if (currentDepth < MAX_DEPTH) {

            // 3. Rastreamos otros enlaces si no encontramos un partner link y no estamos muy profundo
            await enqueueOtherLinks(enqueueLinks, currentDepth);

        }
    };

    ///<summary>Anade enlaces internos que no son de partner a la cola para un rastreo superficial</summary>
    const enqueueOtherLinks = async (enqueueLinks, currentDepth) => {
        // Usamos la funcion enqueueLinks del contexto, que ya tiene configurado el $ y la cola
        await enqueueLinks({
            selector: 'a', // Rastrea todos los enlaces
            userData: { depth: currentDepth + 1, isPartnerPage: false },
        });
    };

    // #endregion Funciones Internas

    // #region Funciones Externas

    ///<summary>Busca un enlace de partner/afiliado en la pagina actual</summary>
    const findPartnerLink = ($, sourceUrl) => {

        // #region Variables
        ///<summary>Lista de dominios que suelen ser comunidades o redes sociales, no programas de afiliados directos</summary>
        const IGNORE_DOMAINS = ['twitter.com', 'facebook.com', 'discord.gg', 'instagram.com', 'linkedin.com', 'youtube.com', 't.me', 'reddit.com', 'github.com'];
        // #endregion Variables

        let partnerLink = null;

        // El selector busca todos los elementos de anclaje (enlaces)
        $('a').each((_index, element) => {
            const linkText = $(element).text().toLowerCase();
            const href = $(element).attr('href') || '';
            const linkHref = href.toLowerCase();

            // 1. FILTRO DE DOMINIOS NO DESEADOS
            const isIgnored = IGNORE_DOMAINS.some(domain => linkHref.includes(domain));
            if (isIgnored) {
                return true; // Continuar con el siguiente enlace (usamos 'true' para continuar en jQuery .each())
            }

            // 2. VERIFICACION DE PALABRAS CLAVE
            // Verificamos si el texto del enlace o su URL contiene alguna de las palabras clave
            const isMatch = KEYWORDS.some(keyword =>
                linkText.includes(keyword) || linkHref.includes(keyword)
            );

            if (isMatch) {
                // Devolvemos el primer enlace coincidente que parezca prometedor
                // Usamos la clase URL de Node.js para resolver rutas relativas
                try {
                    partnerLink = new URL(href, sourceUrl).href;
                } catch (e) {
                    // Si la URL es inválida o el parseo falla, lo ignoramos y seguimos
                    return true;
                }

                return false; // Salir del bucle .each()
            }
        });

        return partnerLink;
    };


    ///<summary>Extrae emails y verifica la existencia de formularios en la pagina del programa</summary>
    const extractContactInfo = ($, url, sourceUrl) => {

        // 1. Buscamos un email usando una expresion regular
        const html = $.html();
        const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi;
        const foundEmails = [...new Set(html.match(emailRegex))]; // Usamos Set para emails unicos

        // 2. Buscamos formularios (indicio de un formulario de contacto para el programa)
        const formExists = $('form').length > 0;

        return {
            sourceUrl: sourceUrl,
            partnerPageUrl: url,
            foundEmails: foundEmails.join(', ') || 'No encontrado',
            contactFormExists: formExists ? 'Si' : 'No'
        };
    };

    // #endregion Funciones Externas

    // #region Logica Principal

    if (!_input || !_input.startUrls || _input.startUrls.length === 0) {
        throw new Error('Debe proporcionar URLs de inicio.');
    }

    ///<summary>La cola para gestionar las URLs pendientes</summary>
    const _requestQueue = await RequestQueue.open();

    // Anadimos las URLs iniciales a la cola
    for (const startUrl of _input.startUrls) { // <-- CAMBIADO DE 'url' a 'startUrl'
        await _requestQueue.addRequest({
            url: startUrl.url, // <-- USANDO 'startUrl.url'
            userData: { depth: 0, isPartnerPage: false }
        });
    }

    // Creamos y configuramos el rastreador
    const crawler = new CheerioCrawler({
        requestQueue: _requestQueue,
        requestHandler: handlePageFunction,
        maxRequestsPerCrawl: 50, // Límite para evitar abusos
    });

    // Ejecutamos el rastreador
    await crawler.run();

    // #endregion Logica Principal
});