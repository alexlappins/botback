-- Удалить строки с template_id IS NULL во всех таблицах шаблонов
-- Выполни в psql или любом клиенте к своей БД (подставь свои параметры подключения).

DELETE FROM template_reaction_roles WHERE template_id IS NULL;
DELETE FROM template_log_channels WHERE template_id IS NULL;
DELETE FROM template_messages WHERE template_id IS NULL;
DELETE FROM template_channels WHERE template_id IS NULL;
DELETE FROM template_categories WHERE template_id IS NULL;
DELETE FROM template_roles WHERE template_id IS NULL;
