data "aws_vpc" "host" {
  filter {
    name   = "tag:Name"
    values = [var.host_vpc_name]
  }
}

data "aws_internet_gateway" "host" {
  filter {
    name   = "attachment.vpc-id"
    values = [data.aws_vpc.host.id]
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = data.aws_vpc.host.id
  cidr_block              = var.subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.app_name}-${var.environment}-public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = data.aws_vpc.host.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = data.aws_internet_gateway.host.id
  }

  tags = {
    Name = "${var.app_name}-${var.environment}-public"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}
