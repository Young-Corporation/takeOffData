from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # AWS
    aws_access_key_id:     str
    aws_secret_access_key: str
    aws_region:            str = "us-east-1"
    aws_s3_bucket:         str

    # Database
    database_url: str = "sqlite:///./takeoff_label.db"

    # App
    cors_origins: str = "http://localhost:5173"
    max_file_mb:  int = 200

    @property
    def origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",")]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
