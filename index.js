//Initializing for importing JSON data
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import path from 'path';
import {fileURLToPath} from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
//Importing modules
import publicIp from 'public-ip';
import fetch from 'node-fetch';
import dns from 'dns';
import winston from 'winston';
import { createLogger, format, transports } from 'winston';
import moment from 'moment';
//Define global constants
const lvStrTransform = {
	emerg:  ' EMGC ',
  alert:  ' ALRT ',
  crit:   ' CRIT ',
  error:  ' ERR  ',
  warn:   ' WARN ',
  notice: ' NOTE ',
  info:   ' INFO ',
  debug:  ' DBUG '
}

//Setting modules
const dnsPromises = dns.promises;
const logger = winston.createLogger({
  level: 'info',
  format: format.printf(info => `[${moment().format('YY-MM-DD:HH:mm:ss')}][${lvStrTransform[info.level]}] ${info.message}`),
  transports: [
    //
    // - Write all logs with importance level of `error` or less to `error.log`
    // - Write all logs with importance level of `info` or less to `combined.log`
    //
		new winston.transports.Console(),
    new winston.transports.File({ filename: './logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: './logs/combined.log' }),
  ],
});
//Importing config
const config = require(__dirname + '/config.json');
const handleRecordType = config.settings.handleRecordType;

async function getResolve(config) {
	let record = {};
	let ipArray;
	let host;
	if (config.domain.name != '@')
		host = `${config.domain.name}.${config.domain.fqdn}`;
	else
		host = config.domain.fqdn;
	try {
		ipArray = await dnsPromises.resolve(host);
	} catch (e) {
		logger.error(e);
	} finally {
		record['A'] = {
			rrset_type: 'A',
			rrset_values: ipArray,
			rrset_ttl: 300
		}
	}

	try {
		ipArray = await dnsPromises.resolve6(host);
	} catch (e) {
		logger.error(e);
	} finally {
		record['AAAA'] = {
			rrset_type: 'AAAA',
			rrset_values: ipArray,
			rrset_ttl: 300
		}
	}
	return record;
}

async function getDnsRecored(config) {
	let headers = {
		"authorization": "Apikey " + config.domain.apikey
	}
	const url = `https://api.gandi.net/v5/livedns/domains/${config.domain.fqdn}/records/${config.domain.name}`;
	return fetch(url ,{
		method: 'GET',
		headers: headers,
		redirect: 'follow'
	}).then(res => {
		return res.json();
	}).then(resJson => {
		let record = {};
		for(let i=0;i<resJson.length;i++){
			if(!handleRecordType.includes(resJson[i].rrset_type))
				continue;
			record[resJson[i].rrset_type] = resJson[i];
		}
		return record;
	}).catch(e => {
		throw e;
	});
}

async function updateDnsRecord(argv) {
	const {config, type, method = 'POST', ip} = argv;
	let requestOptions = {
		method: method,
		headers: {
			"authorization": "Apikey " + config.domain.apikey,
			"content-type": "application/json"
		},
		body: JSON.stringify({
			"rrset_values" : [ip],
			"rrset_ttl" : config.settings.ttl
		}),
		redirect: 'follow'
	};
	return fetch(`https://api.gandi.net/v5/livedns/domains/${config.domain.fqdn}/records/${config.domain.name}/${type}`, requestOptions).then(response => {
		if(!(response.status == 201 ||  response.status == 200))
			throw new Error(response.statusText);
		return response.json();
	}).catch(error => {
		logger.error('error', error);
		return response.json();
	});
}

async function mainFlow() {
	let record = {};
	let state = 'getDnsInfo';
	let hFlag = {};
	let putArray = [];
	let postArray = [];
	let ipv4, ipv6;
	let exctptionFlag = false;
	logger.info('Obtaining IPv4.');
	try {
		ipv4 = await publicIp.v4(config.ip);
	} catch (e) {
		logger.error('Cannot obtain the public IPv4.');
		//logger.error(e);
		exctptionFlag = true;
		hFlag.A = true;
	}
	if(!exctptionFlag) {
		exctptionFlag = false;
		logger.info('Current IPv4: ' + ipv4);
	}
	logger.info('Obtaining IPv6.');
	try {
		ipv6 = await publicIp.v6(config.ip);
	} catch (e) {
		logger.error('Cannot obtain the public IPv6.');
		//logger.error(e);
		exctptionFlag = true;
		hFlag.AAAA = true;
	}
	if(!exctptionFlag) {
		exctptionFlag = false;
		logger.info('Current IPv6: ' + ipv6);
	}
	if(hFlag.A && hFlag.AAAA) return;
	logger.info('Obtaining current DNS record.');
	try {
		record = await getDnsRecored(config);
		//record = await getResolve(config);
	} catch (e) {
		logger.error(e);
	}
	//logger.info('Current DNS record:')
	//logger.info(record);
	logger.info('Creating job list.');
	let ip = null;
	for(let i=0; i<handleRecordType.length; i++){
		if (record[handleRecordType[i]] == null && !hFlag[handleRecordType[i]]) {
			//Post
			logger.info(`Record ${handleRecordType[i]} not found, add to new record queue.`);
			switch(handleRecordType[i]){
				case 'A':
					ip = ipv4;
				break;
				case 'AAAA':
					ip = ipv6;
				break;
				default:
					ip = 0;
			}
			postArray.push({
				'config': config,
				'type': handleRecordType[i],
				'method': 'POST',
				'ip': ip
			});
			hFlag[handleRecordType[i]] = true;
		}
		if (record[handleRecordType[i]] != null && !hFlag[handleRecordType[i]]){
			//Put
			switch(handleRecordType[i]){
				case 'A':
					ip = ipv4;
				break;
				case 'AAAA':
					ip = ipv6;
				break;
				default:
					ip = 0;
			}
			if(ip != null && record[handleRecordType[i]].rrset_values.includes(ip)){
				hFlag[handleRecordType[i]] = true;
				continue;
			}
			logger.info(`Record ${handleRecordType[i]} add to update queue.`);
			postArray.push({
				'config': config,
				'type': handleRecordType[i],
				'method': 'PUT',
				'ip': ip
			});
			hFlag[handleRecordType[i]] = true;
		}
	}
	if(postArray.length <= 0) {
		logger.info('No updating jobs !');
		return;
	}
	logger.info('Updating DNS record.');
	let result;
	for(let i=0; i<postArray.length; i++){
		//logger.log(postArray[i]);
		result = await updateDnsRecord(postArray[i]);
		logger.info(result);
	}

}

setInterval((async() => {
	mainFlow();
}), config.settings.updateInterval);
