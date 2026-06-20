ALTER TABLE portal.roles
    ADD CONSTRAINT fk_roles_created_by FOREIGN KEY (created_by) REFERENCES portal.users(id),
    ADD CONSTRAINT fk_roles_updated_by FOREIGN KEY (updated_by) REFERENCES portal.users(id);

ALTER TABLE portal.modules
    ADD CONSTRAINT fk_modules_created_by FOREIGN KEY (created_by) REFERENCES portal.users(id),
    ADD CONSTRAINT fk_modules_updated_by FOREIGN KEY (updated_by) REFERENCES portal.users(id);

ALTER TABLE portal.permissions
    ADD CONSTRAINT fk_permissions_created_by FOREIGN KEY (created_by) REFERENCES portal.users(id),
    ADD CONSTRAINT fk_permissions_updated_by FOREIGN KEY (updated_by) REFERENCES portal.users(id);

ALTER TABLE portal.role_permissions
    ADD CONSTRAINT fk_role_permissions_created_by FOREIGN KEY (created_by) REFERENCES portal.users(id);

ALTER TABLE portal.user_permissions
    ADD CONSTRAINT fk_user_permissions_created_by FOREIGN KEY (created_by) REFERENCES portal.users(id);

ALTER TABLE portal.user_modules
    ADD CONSTRAINT fk_user_modules_created_by FOREIGN KEY (created_by) REFERENCES portal.users(id);
