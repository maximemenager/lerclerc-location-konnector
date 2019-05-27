process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://202eaf14d6a741cc94b844fa7bcbaf51@sentry.cozycloud.cc/127'

const { BaseKonnector, scrape, saveBills, log } = require('cozy-konnector-libs')

module.exports = new BaseKonnector(start)

var rp = require('request-promise')
const cheerio = require('cheerio')
const moment = require('moment')

var cookiejar = rp.jar()

var baseURL = 'https://www.location.leclerc'

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching the list of documents')
  const html = await getDocuments()

  log('info', 'Parsing list of documents')
  const $ = cheerio.load(html)
  const docs = parseDocuments($)

  // here we use the saveBills function even if what we fetch are not bills, but this is the most
  // common case in connectors
  log('info', 'Saving data to Cozy')
  await saveBills(docs, fields, {
    identifiers: ['']
  })
}

// Get the sample page and parse the cookie
function authenticate(username, password) {
  const options = {
    uri: baseURL,
    jar: cookiejar
  }

  const optionsLogin = {
    uri: baseURL + '/ajax-login-compte',
    headers: {
      'X-Requested-With': 'XMLHttpRequest'
    },
    qs: {
      email: username,
      mdp: password
    },
    jar: cookiejar
  }

  // Send initial request to get session cookies
  return rp(options)
    .then(function() {
      // Change the options, but keep the cookiejar
      rp(optionsLogin)
        .then(function(json_string) {
          const json = JSON.parse(json_string)
          if (
            json['statut'] === 'erreur' &&
            json['message'] == 'Email ou mot de passe incorrect'
          ) {
            throw new Error('LOGIN_FAILED')
          }
        })
        .catch(function(err) {
          log('error', err.message)
          throw new Error('UNKNOWN_ERROR')
        })
    })
    .catch(function(err) {
      log('error', err.message)
      log('error', 'Failed')
    })
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
function getDocuments() {
  // Must do this request to get the bill page
  const optionstmp = {
    uri: baseURL + '/compte',
    jar: cookiejar
  }

  const optionsBillPage = {
    uri: baseURL + '/mes-reservations',
    jar: cookiejar
  }

  return rp(optionstmp).then(() =>
    rp(optionsBillPage)
      .then(html => html)
      .catch(function(err) {
        log('error', err.message)
        throw new Error('UNKNOWN_ERROR')
      })
  )
}

function extractIDAndDateFromTitle(title) {
  const re = RegExp(/Réservation (\w+?) du (.+?)$/)
  const matches = re.exec(title)
  const id = matches[1]
  const date = moment(matches[2], 'DD/MM/YYYY à hh:mm').toDate()

  return { id: id, date: date }
}

function parseDocuments($) {
  const items = scrape(
    $,
    {
      title: {
        sel: '.title',
        parse: title => title.replace(/\n/gm, '').replace(/\s+/g, ' ')
      },
      amount: {
        sel: 'div[class*=prix]',
        parse: amount => parseFloat(amount.replace('€', '').replace(',', '.'))
      },
      fileurl: {
        sel: 'a[target=_blank]',
        attr: 'href'
      }
    },
    'div[class="row form"]'
  )

  // Generate ID, date from items
  const newItems = items.map(function(item) {
    let extracted = extractIDAndDateFromTitle(item.title)
    item.vendorRef = extracted.id
    item.date = extracted.date
    item.filename =
      [
        moment().format('YYYY-MM-DD', item.date),
        'LocationLeclerc',
        item.amount + '€',
        extracted.id
      ].join('_') + '.pdf'
    delete item.title
    return item
  })

  return newItems.map(doc => ({
    ...doc,
    date: doc.date,
    currency: '€',
    vendor: 'Location Leclerc',
    metadata: {
      importDate: new Date(),
      version: 1
    }
  }))
}
