-- 建表脚本约定：每个业务模块一个文件（如 10-library.sql），只用 CREATE TABLE / INDEX IF NOT EXISTS；
-- 启动时按文件名顺序执行。不做迁移：表结构变更后删除数据目录中的 zhiying.db 重建。
SELECT 1;
