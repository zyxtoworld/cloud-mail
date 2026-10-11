import orm from '../entity/orm';
import { att } from '../entity/att';
import { and, eq, isNull, inArray, desc } from 'drizzle-orm';
import r2Service from './r2-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { attConst } from '../const/entity-const';
import { parseHTML } from 'linkedom';
import { v4 as uuidv4 } from 'uuid';
import domainUtils from '../utils/domain-uitls';
import settingService from "./setting-service";

const attService = {

	async addAtt(c, attachments) {

		for (let attachment of attachments) {

			let metadate = {
				contentType: attachment.mimeType,
			}

			if (!attachment.contentId) {
				metadate.contentDisposition = `attachment;filename=${attachment.filename}`
			} else {
				metadate.contentDisposition = `inline;filename=${attachment.filename}`
				metadate.cacheControl = `max-age=259200`
			}

			await r2Service.putObj(c, attachment.key, attachment.content, metadate);

		}

		await orm(c).insert(att).values(attachments).run();
	},

	list(c, params, userId) {
		const { emailId } = params;

		return orm(c).select().from(att).where(
			and(
				eq(att.emailId, emailId),
				eq(att.userId, userId),
				eq(att.type, attConst.type.ATT),
				isNull(att.contentId)
			)
		).all();
	},

	async toImageUrlHtml(c, content) {

		if (!content || !/<img\b/i.test(content)) {
			return { imageDataList: [], html: content || '' };
		}

		const { r2Domain } = await settingService.query(c);
		const ossDomain = domainUtils.toOssDomain(r2Domain);
		const { document } = parseHTML(content);
		const images = Array.from(document.querySelectorAll('img'));
		let imageDataList = [];

		for (const img of images) {
			//邮件正文base64图片转cid附件
			const src = img.getAttribute('src');
			if (src && src.startsWith('data:image')) {
				const file = fileUtils.base64ToFile(src);
				const buff = await file.arrayBuffer();
				const cid = uuidv4().replace(/-/g, '');
				const key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(buff) + fileUtils.getExtFileName(file.name);

				img.setAttribute('src', 'cid:' + cid);

				const attData = {};
				attData.key = key;
				attData.filename = file.name;
				attData.mimeType = file.type;
				attData.size = file.size;
				attData.buff = buff;
				attData.content = fileUtils.base64ToDataStr(src);
				attData.contentId = cid;

				imageDataList.push(attData);
			}

			//邮件正文站内图片转cid附件
			if (src && ((ossDomain && src.startsWith(ossDomain)) || src.startsWith('attachments/'))) {
				const cid = uuidv4().replace(/-/g, '');
				img.setAttribute('src', 'cid:' + cid);

				const attData = {};
				if (ossDomain && src.startsWith(ossDomain)) {
					attData.key = src.replace(ossDomain + '/', '');
				} else {
					attData.key = src;
				}

				attData.contentId = cid;
				attData.type = attConst.type.EMBED;
				imageDataList.push(attData);
			}

			const hasInlineWidth = img.hasAttribute('width');
			const style = img.getAttribute('style') || '';
			const hasStyleWidth = /(^|\s)width\s*:\s*[^;]+/.test(style);

			if (!hasInlineWidth && !hasStyleWidth) {
				const newStyle = (style ? style.trim().replace(/;$/, '') + '; ' : '') + 'max-width: 100%;';
				img.setAttribute('style', newStyle);
			}
		}

		//查询已有内嵌url图片信息
		const keys = [...new Set(imageDataList.filter(item => !item.content).map(item => item.key))];
		const dbImageList = await this.selectOneByKeys(c, keys);
		const dbImageByKey = new Map(dbImageList.map(dbImage => [dbImage.key, dbImage]));

		//设置给当前附件
		const contentByKey = new Map();
		await Promise.all(imageDataList.map(async image => {
			if (image.content) {
				return;
			}

			const dbImage = dbImageByKey.get(image.key);
			if (!dbImage) {
				return;
			}

			image.size = dbImage.size;
			image.filename = dbImage.filename;
			image.mimeType = dbImage.mimeType;
			image.contentType = dbImage.mimeType;

			let contentPromise = contentByKey.get(image.key);
			if (!contentPromise) {
				contentPromise = r2Service.getObj(c, image.key).then(obj => {
					if (!obj) return null;
					return obj instanceof ArrayBuffer ? obj : obj.arrayBuffer();
				});
				contentByKey.set(image.key, contentPromise);
			}

			image.content = await contentPromise;
		}));

		imageDataList = imageDataList.filter(image => image.content);

		return { imageDataList, html: document.toString() };
	},

	async saveSendAtt(c, attList, userId, accountId, emailId) {

		const attDataList = [];

		for (let att of attList) {
			att.buff = fileUtils.base64ToUint8Array(att.content);
			att.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(att.buff) + fileUtils.getExtFileName(att.filename);
			const attData = { userId, accountId, emailId };
			attData.key = att.key;
			attData.size = att.buff.length;
			attData.filename = att.filename;
			attData.mimeType = att.type;
			attData.type = attConst.type.ATT;
			attDataList.push(attData);
		}

		await orm(c).insert(att).values(attDataList).run();

		for (let att of attList) {
			await r2Service.putObj(c, att.key, att.buff, {
				contentType: att.type,
				contentDisposition: `attachment;filename=${att.filename}`
			});
		}

	},

	async saveArticleAtt(c, attDataList, userId, accountId, emailId) {

		for (let attData of attDataList) {
			attData.userId = userId;
			attData.emailId = emailId;
			attData.accountId = accountId;
			attData.type = attConst.type.EMBED;
			if (!attData.buff) {
				continue;
			}
			await r2Service.putObj(c, attData.key, attData.buff, {
				contentType: attData.mimeType,
				cacheControl: `max-age=259200`,
				contentDisposition: `inline;filename=${attData.filename}`
			});
			delete attData.buff;
		}

		await orm(c).insert(att).values(attDataList).run();

	},

	async removeByUserIds(c, userIds) {
		await this.removeAttByField(c, 'user_id', userIds);
	},

	async removeByEmailIds(c, emailIds) {
		await this.removeAttByField(c, 'email_id', emailIds);
	},

	selectByEmailIds(c, emailIds) {
		return orm(c).select().from(att).where(
			and(
				inArray(att.emailId, emailIds),
				eq(att.type, attConst.type.ATT)
			))
			.all();
	},

	async removeAttByField(c, fieldName, fieldValues) {
		const allowedFields = {
			user_id: 'user_id',
			email_id: 'email_id',
			account_id: 'account_id'
		};
		const column = allowedFields[fieldName];
		if (!column || !fieldValues?.length) {
			return;
		}

		const values = [...new Set(fieldValues)];
		const BATCH_SIZE = 90;

		for (let i = 0; i < values.length; i += BATCH_SIZE) {
			const batchValues = values.slice(i, i + BATCH_SIZE);
			const placeholders = batchValues.map(() => '?').join(', ');
			const selectKeys = c.env.db.prepare(
				`SELECT key
				 FROM attachments
				 GROUP BY key
				 HAVING COUNT(*) = SUM(CASE WHEN ${column} IN (${placeholders}) THEN 1 ELSE 0 END)`
			).bind(...batchValues);
			const deleteRows = c.env.db.prepare(
				`DELETE FROM attachments WHERE ${column} IN (${placeholders})`
			).bind(...batchValues);

			const [keyResult] = await c.env.db.batch([selectKeys, deleteRows]);
			const delKeyList = keyResult.results?.map(row => row.key) || [];

			if (delKeyList.length > 0) {
				try {
					await this.batchDelete(c, delKeyList);
				} catch (e) {
					console.error('删除附件文件失败：', e);
				}
			}
		}

	},

	async batchDelete(c, keys) {
		if (!keys.length) return;

		const BATCH_SIZE = 1000;

		for (let i = 0; i < keys.length; i += BATCH_SIZE) {
			const batch = keys.slice(i, i + BATCH_SIZE);
			await r2Service.delete(c, batch);
		}

	},

	async removeByAccountId(c, accountId) {
		await this.removeAttByField(c, "account_id", [accountId])
	},

	selectOneByKeys(c, keys) {
		if (!keys || keys.length === 0) {
			return []
		}
		return orm(c).select().from(att).where(inArray(att.key, keys)).orderBy(desc(att.attId)).groupBy(att.key).all();
	}
};

export default attService;
